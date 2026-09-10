"""BEM → 동적 유입 → 단면 양력/항력 → 전역 절점 하중 순서의 공력 알고리즘.

BEM은 각 반경의 날개가 원판에 주는 힘과 공기의 운동량 변화가 같아지도록
유도계수를 찾는다. a와 a'를 번갈아 추측하는 대신 유입각 phi 한 개를 푼다.
Ning (2014), doi:10.1002/we.1636; Øye 식은 OpenFAST AeroDyn theory를 따른다.
유입각은 정방향 운전 사분면에서 푼다. 역류/propeller 운전은 별도 모델이다.
"""

import math
from bisect import bisect_right
from itertools import pairwise

import numpy as np
from scipy.optimize import brentq


def bem_section(
    axial_speed,
    tangential_speed,
    radius,
    chord,
    pitch,
    angles,
    lift,
    drag,
    blade_count,
    hub_radius,
    rotor_radius,
):
    """한 단면의 (a, a', phi, 잔차)를 반환한다. 입력은 SI와 rad이다.

    Prandtl 계수는 끝과 허브에서 원판이 무한 날개와 다르다는 점을 보정한다.
    a>0.4 영역은 단순 운동량식의 적용 범위를 벗어나므로 Buhl 식으로 연결한다.
    근이 없을 때 임의의 유도계수를 채택하지 않고 계산 실패를 알린다.
    """
    if not hub_radius <= radius <= rotor_radius or chord <= 0:
        raise ValueError(
            "BEM radius must be between hub and tip and chord must be positive"
        )
    if axial_speed < -1e-10 or tangential_speed < -1e-10:
        raise ValueError("BEM supports forward axial flow and positive rotor rotation")
    if radius == hub_radius or radius == rotor_radius:
        # Prandtl 끝점의 고정 유도 극한. phi=0이어도 Cd/Cl에 의한 단면 힘은 남는다.
        return 1.0, 0.0, 0.0, 0.0
    if axial_speed <= 1e-10 or tangential_speed <= 1e-10:
        # 회전 또는 축 유입이 없는 극한에서는 원판 운동량을 적용하지 않는다.
        return 0.0, 0.0, math.atan2(axial_speed, tangential_speed), 0.0
    solidity = blade_count * chord / (2 * math.pi * radius)
    tip_factor = blade_count * (rotor_radius - radius) / (2 * radius)
    hub_factor = blade_count * (radius - hub_radius) / (2 * hub_radius)
    speed_ratio = axial_speed / tangential_speed

    def induction(phi):
        sine, cosine = math.sin(phi), math.cos(phi)
        alpha = phi - pitch
        # Cl과 Cd는 같은 alpha 구간을 사용합니다. 구간을 한 번만 이진 탐색하고
        # np.interp와 같은 선형 보간/끝값 고정을 적용합니다. 운전 파형에서는
        # 읽기 전용 polar의 Python 숫자 목록을 호출 전에 한 번 준비합니다.
        upper = bisect_right(angles, alpha)
        if upper == 0:
            cl, cd = lift[0], drag[0]
        elif upper == len(angles):
            cl, cd = lift[-1], drag[-1]
        else:
            lower = upper - 1
            width, distance = angles[upper] - angles[lower], alpha - angles[lower]
            cl = lift[lower] + (lift[upper] - lift[lower]) / width * distance
            cd = drag[lower] + (drag[upper] - drag[lower]) / width * distance
        cn, ct = cl * cosine + cd * sine, cl * sine - cd * cosine
        tip, hub = tip_factor / sine, hub_factor / sine
        loss = max(
            1e-8,
            (2 / math.pi * math.acos(math.exp(-tip)))
            * (2 / math.pi * math.acos(math.exp(-hub))),
        )
        k = solidity * cn / (4 * loss * sine * sine)
        if k <= 2 / 3:
            a = k / (1 + k) if abs(1 + k) > 1e-12 else math.inf
        else:
            # 이것은 경험적 CT(a)와 blade-element CT를 같게 놓은 이차식의 해다.
            g1 = 2 * loss * k - (10 / 9 - loss)
            g2 = 2 * loss * k - loss * (4 / 3 - loss)
            g3 = 2 * loss * k - (25 / 9 - 2 * loss)
            a = (
                (g1 - math.sqrt(g2)) / g3
                if abs(g3) > 1e-10
                else 1 - 1 / (2 * math.sqrt(g2))
            )
        kp = solidity * ct / (4 * loss * sine * cosine)
        ap = kp / (1 - kp) if abs(1 - kp) > 1e-12 else math.inf
        return a, ap, sine / (1 - a) - speed_ratio * cosine / (1 + ap)

    def residual(phi):
        return induction(phi)[2]

    # 일반 운전은 전체 구간에서 풀립니다. 실패한 경우에만 기존과 같은
    # 65개 경계/64개 부분 구간을 만들므로 근 탐색 순서와 허용오차는 같습니다.
    for subdivide in (False, True):
        brackets = (
            pairwise(np.linspace(1e-7, math.pi / 2 - 1e-7, 65))
            if subdivide
            else ((1e-7, math.pi / 2 - 1e-7),)
        )
        for left, right in brackets:
            try:
                if residual(left) * residual(right) > 0:
                    continue
                phi = brentq(residual, left, right, xtol=1e-12, rtol=1e-12)
                a, ap, error = induction(phi)
                error = abs(error)
                if error < 1e-8 and -1 < a < 1 and ap > -1:
                    return a, ap, phi, error
            except (ValueError, ZeroDivisionError, OverflowError):
                continue
    raise ValueError(
        "BEM inflow-angle solve did not converge in the forward-flow quadrant"
    )


def oye_step(reduced, induced, quasi_steady, dt, tau1, tau2, coupling=0.6):
    """Øye 두 일차 필터를 구간의 일정 유도속도에 대해 정확히 전진한다.

    reduced=(중간 유도속도 - coupling*준정상 유도속도)이다. 이 상태를 저장하면
    준정상 값이 급변해도 미분값을 수치 차분할 필요가 없다. 각 성분은 m/s이다.
    """
    e1, e2 = np.exp(-dt / tau1), np.exp(-dt / tau2)
    target = (1 - coupling) * quasi_steady
    if np.ndim(tau2) == 0:
        convolution = (
            dt / tau1 * e1
            if abs(tau1 - tau2) < 1e-12 * tau1
            else tau1 / (tau1 - tau2) * (e1 - e2)
        )
    else:
        # 반경별 tau2[:, None]을 넣으면 모든 단면과 두 유도속도 성분이
        # 같은 정확 적분식을 함께 사용합니다. 같은 시정수의 극한도 보존합니다.
        convolution = np.full_like(tau2, dt / tau1 * e1)
        np.divide(
            tau1 * (e1 - e2),
            tau1 - tau2,
            out=convolution,
            where=abs(tau1 - tau2) >= 1e-12 * tau1,
        )
    return target + (reduced - target) * e1, induced * e2 + quasi_steady * (1 - e2) + (
        reduced - target
    ) * convolution


def aerodynamic_response(
    settings, sections, model, motion, previous=None, cancellation=None
):
    """운동 파형을 공력 파형으로 변환한다. 호출자의 checkpoint는 수정하지 않는다.

    orientation의 열은 [span, chord, normal]이고 local→world 변환이다.
    현재 pitch와 탄성 비틀림은 이미 orientation에 들어 있다. 단면 공력 twist만
    추가하여 angle of attack을 만들므로 pitch를 두 번 적용하지 않는다.
    """
    previous = previous or {}
    times = np.asarray(motion["times"], dtype=float)
    if len(times) == 0 or np.any(np.diff(times) <= 0):
        raise ValueError("aerodynamic sample times must increase")
    if previous and (
        previous["modelIdentity"] != model["modelIdentity"]
        or not np.isclose(previous["time"], times[0], rtol=0, atol=1e-10)
    ):
        raise ValueError("aerodynamic checkpoint must start this model's time window")
    indices = np.asarray(sections["indices"], dtype=int)
    count = len(indices)
    angles = np.asarray(sections["polarAngles"], dtype=float)
    if count == 0 or len(angles) < 2 or np.any(np.diff(angles) <= 0):
        raise ValueError(
            "blade sections and strictly increasing polar angles are required"
        )
    radii = np.asarray(sections["radii"], dtype=float)
    lengths = np.asarray(sections["lengths"], dtype=float)
    chords = np.asarray(sections["chord"], dtype=float)
    twists = np.asarray(sections["twist"], dtype=float)
    polar_indices = np.asarray(sections["polarIndices"], dtype=int)
    lift = np.asarray(sections["liftCoefficients"], dtype=float)
    drag = np.asarray(sections["dragCoefficients"], dtype=float)
    polar_moments = np.asarray(sections["momentCoefficients"], dtype=float)
    if np.any(lengths <= 0):
        raise ValueError("aerodynamic tributary lengths must be positive")
    # 반경별 고리 면적은 r*dr에 비례한다. 비균일 절점 간격을 단순 평균하지 않는다.
    disk_weights = radii * lengths
    offsets = np.asarray(
        sections.get("aerodynamicOffsets", np.zeros((count, 3))), dtype=float
    )
    if offsets.shape != (count, 3):
        raise ValueError(
            "aerodynamicOffsets must contain one local three-vector per section"
        )
    if np.any(drag < 0):
        raise ValueError("airfoil drag coefficients must be nonnegative")
    positions = np.asarray(motion["positions"], dtype=float)
    orientations = np.asarray(motion["orientations"], dtype=float)
    velocities = np.asarray(motion["velocities"], dtype=float)
    has_offsets = bool(np.any(offsets))
    angular_velocities = (
        np.asarray(motion["angularVelocities"], dtype=float) if has_offsets else None
    )
    forces = np.zeros_like(positions)
    moments = np.zeros_like(forces)
    axis = np.array(settings["rotorAxis"], dtype=float, copy=True)
    axis_length = np.linalg.norm(axis)
    if axis_length <= 1e-12:
        raise ValueError("rotor axis must be nonzero")
    axis /= axis_length
    rho, radius = float(settings["airDensity"]), float(settings["rotorRadius"])
    if rho <= 0 or radius <= 0 or float(settings["referenceHeight"]) <= 0:
        raise ValueError(
            "air density, rotor radius and reference height must be positive"
        )
    wind_times = np.asarray(settings["windTimes"], dtype=float)
    wind_values = np.asarray(settings["windVelocities"], dtype=float)
    if (
        len(wind_times) == 0
        or np.any(np.diff(wind_times) <= 0)
        or wind_values.shape != (len(wind_times), 3)
    ):
        raise ValueError(
            "wind requires increasing times and one three-component velocity per time"
        )
    winds = np.column_stack(
        [
            np.interp(times, wind_times, wind_values[:, component])
            for component in range(3)
        ]
    )
    height_reference = float(settings["referenceHeight"])
    shear_exponent = float(settings["shearExponent"])
    blade_count, hub_radius = int(settings["bladeCount"]), float(settings["hubRadius"])
    dynamic_inflow = bool(settings["dynamicInflow"])
    tau2_factors = (0.39 - 0.26 * (radii / radius) ** 2)[:, None]
    # BEM의 반복 안에서 같은 polar를 배열로 변환하거나 같은 반경/길이를
    # 다시 읽지 않습니다. 단면의 불변 입력만 현재 호출 동안 재사용합니다.
    angle_values, lift_values, drag_values = (
        angles.tolist(),
        lift.tolist(),
        drag.tolist(),
    )
    stations = [
        (
            float(radii[section]),
            float(chords[section]),
            lift_values[polar],
            drag_values[polar],
        )
        for section, polar in enumerate(polar_indices)
    ]
    polar_groups = [
        (
            np.flatnonzero(polar_indices == polar),
            lift[polar],
            drag[polar],
            polar_moments[polar],
        )
        for polar in np.unique(polar_indices)
    ]
    reduced = np.array(
        previous.get("reducedInduction", np.zeros((count, 2))), dtype=float, copy=True
    )
    induced = np.array(
        previous.get("inducedVelocity", np.zeros((count, 2))), dtype=float, copy=True
    )
    last_quasi = np.array(
        previous.get("quasiSteadyInduction", np.zeros((count, 2))),
        dtype=float,
        copy=True,
    )
    maximum_a = maximum_residual = 0.0
    for sample, time in enumerate(times):
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        # [단면, xyz] 배열에서 각 행이 독립적인 단면입니다. 기존의 외적/내적과
        # 같은 식을 행 전체에 적용하므로 수많은 길이 3 배열의 호출 비용을 줄입니다.
        orientation = orientations[sample, indices]
        world_offsets = np.einsum("nij,nj->ni", orientation, offsets)
        span, chord_axis = orientation[:, :, 0], orientation[:, :, 1]
        tangent = np.cross(axis, span)
        tangent /= np.linalg.norm(tangent, axis=1)[:, None]
        normal = np.cross(span, tangent)
        height = positions[sample, indices, 2] + world_offsets[:, 2]
        shear = (np.maximum(height, 0.01) / height_reference) ** shear_exponent
        point_velocity = velocities[sample, indices]
        if has_offsets:
            # 강체 단면의 작용점 속도: v_AC = v_node + omega × offset.
            point_velocity = point_velocity + np.cross(
                angular_velocities[sample, indices], world_offsets
            )
        relative = winds[sample] * shear[:, None] - point_velocity
        speeds = np.column_stack(
            (
                np.einsum("ni,ni->n", relative, normal),
                -np.einsum("ni,ni->n", relative, tangent),
            )
        )
        # 양의 feather pitch는 leading edge를 바람 쪽으로, 즉 -span 방향으로 돌립니다.
        pitches = (
            -np.arctan2(
                np.einsum("ni,ni->n", chord_axis, normal),
                np.einsum("ni,ni->n", chord_axis, tangent),
            )
            + twists
        )
        quasi, axial_inductions = np.empty((count, 2)), np.empty(count)
        for section, (section_radius, chord, section_lift, section_drag) in enumerate(
            stations
        ):
            axial, tangential = float(speeds[section, 0]), float(speeds[section, 1])
            a, ap, _, residual = bem_section(
                axial,
                tangential,
                section_radius,
                chord,
                float(pitches[section]),
                angle_values,
                section_lift,
                section_drag,
                blade_count,
                hub_radius,
                radius,
            )
            quasi[section] = [axial * a, tangential * ap]
            axial_inductions[section] = a
            maximum_a, maximum_residual = (
                max(maximum_a, a),
                max(maximum_residual, residual),
            )
        if sample == 0 and not previous:
            induced, reduced = quasi.copy(), 0.4 * quasi
        elif sample > 0 and dynamic_inflow:
            mean_speed = max(0.1, float(np.average(speeds[:, 0], weights=disk_weights)))
            mean_induction = float(np.average(axial_inductions, weights=disk_weights))
            tau1 = 1.1 * radius / (mean_speed * (1 - 1.3 * min(mean_induction, 0.5)))
            # 중간값과 기존 Øye 정확 적분식을 모든 반경에 함께 적용합니다.
            reduced, induced = oye_step(
                reduced,
                induced,
                (last_quasi + quasi) / 2,
                time - times[sample - 1],
                tau1,
                tau2_factors * tau1,
            )
        if not dynamic_inflow:
            induced, reduced = quasi.copy(), 0.4 * quasi
        axial, tangential = speeds[:, 0] - induced[:, 0], speeds[:, 1] + induced[:, 1]
        phi = np.arctan2(axial, tangential)
        alpha = phi - pitches
        cl, cd, cm = np.empty(count), np.empty(count), np.empty(count)
        for group, group_lift, group_drag, group_moment in polar_groups:
            cl[group] = np.interp(alpha[group], angles, group_lift)
            cd[group] = np.interp(alpha[group], angles, group_drag)
            cm[group] = np.interp(alpha[group], angles, group_moment)
        pressure = 0.5 * rho * (axial * axial + tangential * tangential)
        cosine, sine = np.cos(phi), np.sin(phi)
        section_force = (pressure * chords * lengths)[:, None] * (
            (cl * cosine + cd * sine)[:, None] * normal
            + (cl * sine - cd * cosine)[:, None] * tangent
        )
        # np.add.at은 같은 절점에 둘 이상의 공력 단면이 연결된 경우에도 합산합니다.
        np.add.at(forces[sample], indices, section_force)
        # polar 모멘트와 편심 모멘트 팔을 보존하므로 F·v_AC의 일률도 보존됩니다.
        section_moment = (pressure * chords * chords * lengths * cm)[
            :, None
        ] * span + np.cross(world_offsets, section_force)
        np.add.at(moments[sample], indices, section_moment)
        last_quasi = quasi.copy()
    state = {
        "modelIdentity": model["modelIdentity"],
        "time": float(times[-1]),
        "reducedInduction": reduced,
        "inducedVelocity": induced,
        "quasiSteadyInduction": last_quasi,
    }
    loads = {
        "modelIdentity": model["modelIdentity"],
        "nodeIds": np.asarray(model["nodeIds"], dtype=np.int32),
        "times": times,
        "forces": forces,
        "moments": moments,
        "addedMass": np.zeros((len(model["nodeIds"]), 3, 3)),
        "couplingIteration": np.asarray(
            motion.get("couplingIteration", 0), dtype=np.int32
        ),
    }
    return (
        loads,
        state,
        {
            "maxAxialInduction": maximum_a,
            "maxBEMResidual": maximum_residual,
            "time": float(times[-1]),
        },
    )
