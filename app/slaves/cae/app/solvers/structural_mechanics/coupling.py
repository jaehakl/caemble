"""Solver 하나의 시간 구간 계산과 공개 운동/하중 파형의 변환.

다른 Solver를 import하거나 실행하지 않는다. simulate.py가 같은 시작
checkpoint로 모든 물리를 다시 호출하고, 이 모듈은 그 trial의 구조 응답과
수렴 여부만 돌려준다. 데이터는 실제 시간 좌표와 node ID로 연결한다.
"""

import numpy as np

from app.kernel.api import BundleValue

from .analysis import (
    initial_solution,
    initialize_acceleration,
    kinematic_rates,
    transient_step,
)
from .constraints import enforce_links, revolute_joints, spring_gradient
from .continuum import physical_angular_velocities, physical_orientation_matrices
from .domain import distribute_resultant, parameter, surface_region
from .outputs import interface_members, interface_metadata
from .rotations import (
    rotation_exp,
    rotation_exp_many,
    rotation_log,
    rotation_log_many,
    skew,
)
from .state import append_history, history_sample


def interpolate(times, values, time):
    if len(times) == 1:
        return np.asarray(values[0])
    right = int(np.clip(np.searchsorted(times, time), 1, len(times) - 1))
    fraction = (time - times[right - 1]) / (times[right] - times[right - 1])
    return (1 - fraction) * values[right - 1] + fraction * values[right]


def interpolate_orientations(times, values, time):
    """두 자세 사이의 가장 짧은 SO(3) 경로를 보간한다.

    adaptive substep이 파형 표본 사이에 있어도 직교 회전행렬을 유지한다.
    행렬 성분의 선형 보간은 회전행렬이 아니므로 사용하지 않는다.
    """
    right = int(np.clip(np.searchsorted(times, time), 1, len(times) - 1))
    if time == times[right]:
        return np.asarray(values[right]).copy()
    fraction = (time - times[right - 1]) / (times[right] - times[right - 1])
    left, right_rotation = np.asarray(values[right - 1]), np.asarray(values[right])
    relative = rotation_log_many(right_rotation @ left.transpose(0, 2, 1))
    return rotation_exp_many(fraction * relative) @ left


def apply_resultant_loads(invocation, model):
    """전체 모델의 순간 외력을 상세 모델에 힘/모멘트 보존으로 옮긴다.

    기준점에 대한 합력 F[N], 합모멘트 M[N m]를 먼저 계산한다. 상세 모델의
    절점 i에서 강체 가상운동은 δu_i=B_i[δu,δθ], B_i=[I,-skew(r_i)]다.
    f_i=B_i(ΣBᵀB)^(-1)[F,M]으로 분배하면 ΣB_iᵀf_i=[F,M]이므로 합력,
    합모멘트와 강체 가상일을 모두 보존한다. 절점력의 최소 제곱 해다.
    수력 Solver의 forces는 부가질량을 좌변에 둔 가진력이다. 여기서는
    F_physical=F_excitation-M_added[kg]·a_source[m/s²]로 실제 유체력을 먼저
    복원한다. 이는 원래 전역 동역학의 질량 조립을 변경하거나 중복하지 않는다.
    상세 해석은 순간 외력만 받는 준정적 해석이며 구조 자체의 중력/관성력이나
    경계의 실제 응력 분포까지 복원하는 substructuring은 아니다.
    """
    rules = [rule for rule in invocation.config["boundaryConditions"] if rule["methodId"] == "fea.resultant-transfer"]
    if not rules:
        return
    motion_input = invocation.inputs.get("sourceMotion")
    source_inputs = invocation.inputs.get("sourceLoads", ())
    if not isinstance(source_inputs, (list, tuple)):
        source_inputs = (source_inputs,)
    if motion_input is None or not source_inputs:
        raise ValueError("resultant transfer requires sourceMotion and sourceLoads artifacts")
    motion = motion_input.value.members
    source_ids = np.asarray(motion["nodeIds"])
    source_lookup = {int(node): index for index, node in enumerate(source_ids)}
    target_lookup = {int(node): index for index, node in enumerate(model.node_ids)}
    force = np.zeros((len(source_ids), 3))
    moment = np.zeros_like(force)
    for item in source_inputs:
        load = item.value.members
        if load["modelIdentity"] != motion["modelIdentity"] or not np.array_equal(load["nodeIds"], source_ids) or not np.array_equal(load["times"], motion["times"]):
            raise ValueError("resultant transfer source identities, node IDs and times must agree")
        force += np.asarray(load["forces"])[-1]
        moment += np.asarray(load["moments"])[-1]
        added_mass = np.asarray(load.get("addedMass", np.zeros((len(source_ids), 3, 3))))
        if added_mass.shape != (len(source_ids), 3, 3):
            raise ValueError("resultant transfer added mass must match source nodes")
        if np.any(added_mass):
            if "accelerations" not in motion:
                raise ValueError("resultant transfer of added mass requires source accelerations")
            acceleration = np.asarray(motion["accelerations"])[-1]
            if acceleration.shape != (len(source_ids), 3):
                raise ValueError("resultant transfer acceleration must match source nodes")
            force -= np.einsum("nij,nj->ni", added_mass, acceleration)
    for rule in rules:
        p = {key: parameter(value) for key, value in rule["parameters"].items()}
        if "sourceRegion" in p:
            regions = motion_input.value.metadata.get("regions", {})
            if p["sourceRegion"] not in regions or not len(regions[p["sourceRegion"]]):
                raise ValueError("resultant transfer sourceRegion is absent from sourceMotion geometry metadata")
            source = np.asarray([source_lookup[int(node)] for node in regions[p["sourceRegion"]]])
            region = surface_region(model, rule["target"][0])
            target = region["nodes"]
        else:
            # Explicit arrays are retained only for internal numerical fixtures.
            if model.physical_node_count is not None:
                raise ValueError("generated structural models require a semantic sourceRegion for resultant transfer")
            source = np.asarray([source_lookup[int(node)] for node in p["sourceNodeIds"]])
            target = np.asarray([target_lookup[int(node)] for node in p["targetNodeIds"]])
        if len(set(source)) != len(source) or len(set(target)) != len(target) or not len(source):
            raise ValueError("resultant transfer requires unique nonempty source and target node IDs")
        reference = np.asarray(p["referencePoint"], dtype=float)
        arms = np.asarray(motion["positions"])[-1, source] - reference
        resultant = np.r_[force[source].sum(axis=0), (moment[source] + np.cross(arms, force[source])).sum(axis=0)]
        if "sourceRegion" in p:
            target, distributed = distribute_resultant(model.points, region["faces"], resultant[:3], resultant[3:], reference)
            np.add.at(model.force[:, :3], target, distributed)
            continue
        # m와 rad의 서로 다른 척도로 인한 조건수 악화를 막기 위해 팔 길이를 정규화한다.
        target_arms = model.points[target] - reference
        length = max(np.max(np.linalg.norm(target_arms, axis=1), initial=0), 1e-12)
        blocks = np.asarray([np.column_stack((np.eye(3), -skew(arm / length))) for arm in target_arms])
        metric = np.einsum("nji,njk->ik", blocks, blocks)
        if np.linalg.matrix_rank(metric) < 6:
            raise ValueError("resultant transfer needs at least three noncollinear target nodes")
        generalized = np.r_[resultant[:3], resultant[3:] / length]
        distributed = np.einsum("nij,j->ni", blocks, np.linalg.solve(metric, generalized))
        np.add.at(model.force[:, :3], target, distributed)


def initialize_motion(model, initializations):
    solution = initial_solution(model)
    for rule in initializations:
        if rule["methodId"] == "fea.initial-motion":
            p = rule["parameters"]
            velocity = np.asarray(parameter(p["initialVelocity"]))
            angular = np.asarray(parameter(p["initialAngularVelocity"]))
            if model.physical_node_count is None:
                solution.velocity[:, :3] = velocity
                solution.velocity[:, 3:] = angular
                continue
            selected = np.unique(np.concatenate([model.cell_regions[target] for target in rule["target"]]))
            nodes = np.unique(np.concatenate([model.elements[index].nodes for index in selected]))
            reference = np.asarray(parameter(p["referencePoint"]))
            solution.velocity[nodes, :3] = velocity + np.cross(angular, model.points[nodes] - reference)
            solution.velocity[nodes, 3:] = angular
            for target, node in model.provenance.get("auxiliaryNodes", {}).items():
                if np.isin(model.boundary_regions[target]["nodes"], nodes).all():
                    solution.velocity[node, :3] = velocity + np.cross(angular, model.points[node] - reference)
                    solution.velocity[node, 3:] = angular
    pitch = 0.0
    if model.rotor is not None:
        rotor = model.rotor
        hub, generator = rotor["hubNode"], rotor["generatorNode"]
        angle, speed, pitch = rotor["initialAzimuth"], rotor["initialRotorSpeed"], rotor["initialPitch"]
        rotation = rotation_exp(np.array([angle, 0.0, 0.0]))
        solution.orientations[hub] = rotation
        solution.displacement[hub, 3] = angle
        solution.velocity[hub, 3] = speed
        solution.displacement[generator, 3] = angle * rotor["gearRatio"]
        solution.orientations[generator] = rotation_exp(np.array([angle * rotor["gearRatio"], 0, 0]))
        solution.velocity[generator, 3] = speed * rotor["gearRatio"]
        for name, center, ratio in (("hubBodyNodes", hub, 1.), ("generatorBodyNodes", generator, rotor["gearRatio"])):
            nodes = rotor.get(name, ())
            for node in nodes:
                position = model.points[center] + solution.orientations[center] @ (model.points[node] - model.points[center])
                solution.displacement[node, :3] = position - model.points[node]
                solution.orientations[node] = solution.orientations[center]
                solution.velocity[node, :3] = np.cross([speed * ratio, 0, 0], position - model.points[center])
                solution.velocity[node, 3:] = [speed * ratio, 0, 0]
                solution.acceleration[node, :3] = np.cross([speed * ratio, 0, 0], solution.velocity[node, :3])
        for root, nodes in zip(rotor["bladeRootNodes"], rotor["bladeNodeIds"]):
            span = model.points[root] - model.points[hub]
            span /= np.linalg.norm(span)
            pitch_rotation = rotation_exp(-span * pitch)
            for node in nodes:
                reference = model.points[node]
                if model.physical_node_count is not None:
                    reference = model.points[root] + pitch_rotation @ (reference - model.points[root])
                position = model.points[hub] + rotation @ (reference - model.points[hub])
                solution.displacement[node, :3] = position - model.points[node]
                solution.displacement[node, 3:] = [angle, 0, 0]
                solution.orientations[node] = rotation @ pitch_rotation
                solution.velocity[node, :3] = np.cross([speed, 0, 0], position - model.points[hub])
                solution.velocity[node, 3:] = [speed, 0, 0]
                solution.acceleration[node, :3] = np.cross([speed, 0, 0], solution.velocity[node, :3])
    enforce_links(model, solution.displacement, solution.orientations, pitch)
    append_history(model, solution, pitch)
    return solution


def motion_from_samples(model, samples, pitches, iteration):
    interface = interface_members(model)
    frames = interface["referenceOrientations"]
    rotor_speeds = np.zeros(len(samples))
    generator_speeds = np.zeros(len(samples))
    if model.rotor is not None:
        r = model.rotor
        rotor_speeds = np.array([s.orientations[r["nacelleNode"]][:, 0] @ (s.velocity[r["hubNode"], 3:] - s.velocity[r["nacelleNode"], 3:]) for s in samples])
        generator_speeds = np.array([s.orientations[r["nacelleNode"]][:, 0] @ (s.velocity[r["generatorNode"], 3:] - s.velocity[r["nacelleNode"], 3:]) for s in samples])
    return {"modelIdentity": model.identity, "nodeIds": model.node_ids.astype(np.int32), "times": np.asarray([s.time for s in samples], dtype=float), "positions": np.asarray([model.points + s.displacement[:, :3] for s in samples]), "orientations": np.asarray([physical_orientation_matrices(model, s.displacement, s.orientations) @ frames for s in samples]), "velocities": np.asarray([s.velocity[:, :3] for s in samples]), "angularVelocities": np.asarray([physical_angular_velocities(model, s.displacement, s.velocity) for s in samples]), "accelerations": np.asarray([s.acceleration[:, :3] for s in samples]), "rotorSpeed": rotor_speeds, "generatorSpeed": generator_speeds, "pitch": np.asarray(pitches, dtype=float), "couplingIteration": np.asarray(iteration, dtype=np.int32)}


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


def predict_motion(model, solution, settings):
    from copy import copy
    interval = min(settings["windowSize"], max(settings["duration"] - solution.time, 0.0))
    if interval <= clock_tolerance(settings):
        interval = 0.0
    count = max(1, int(np.ceil(interval / settings["dt"])))
    samples = []
    pitch = 0 if not solution.history else float(solution.history["pitch"][-1][-1])
    for delta in ([0.0] if interval == 0 else np.linspace(0, interval, count + 1)):
        candidate = copy(solution)
        candidate.time = solution.time + delta
        candidate.displacement = solution.displacement + delta * solution.velocity + 0.5 * delta**2 * solution.acceleration
        joint_rates = {}
        for slave, (master, axis_index) in revolute_joints(model).items():
            axis = solution.orientations[master][:, axis_index]
            rate = axis @ (solution.velocity[slave, 3:] - solution.velocity[master, 3:])
            second_rate = axis @ (solution.acceleration[slave, 3:] - solution.acceleration[master, 3:])
            candidate.displacement[slave, 3 + axis_index] = solution.displacement[slave, 3 + axis_index] + delta * rate + .5 * delta**2 * second_rate
            joint_rates[slave] = (rate + delta * second_rate, second_rate)
        candidate.velocity = solution.velocity + delta * solution.acceleration
        candidate.orientations = np.asarray([rotation_exp(delta * v[3:] + 0.5 * delta**2 * a[3:]) @ R for v, a, R in zip(solution.velocity, solution.acceleration, solution.orientations)])
        enforce_links(model, candidate.displacement, candidate.orientations, pitch)
        candidate.velocity, candidate.acceleration, _, _ = kinematic_rates(model, candidate.orientations, candidate.velocity, solution.acceleration, joint_rates=joint_rates)
        samples.append(candidate)
    return BundleValue(
        "caemble.mechanics/motion@1",
        motion_from_samples(model, samples, [pitch] * len(samples), 0),
        interface_metadata(model),
    )


def advance_window(invocation, model, solution, settings, matrices):
    K, base_mass, base_damping, prepared = matrices
    previous_artifact = invocation.inputs.get("previousMotion")
    previous = None if previous_artifact is None else previous_artifact.value
    load_inputs = invocation.inputs.get("loads", ())
    if not isinstance(load_inputs, (list, tuple)):
        load_inputs = (load_inputs,)
    loads = [item.value.members for item in load_inputs]
    control_input = invocation.inputs.get("control")
    control = None if control_input is None else control_input.value.members
    if previous is None:
        previous = predict_motion(model, solution, settings)
    old = previous.members
    times = np.asarray(old["times"], dtype=float)
    if old["modelIdentity"] != model.identity or not np.array_equal(old["nodeIds"], model.node_ids) or not np.isclose(times[0], solution.time, atol=1e-10, rtol=0):
        raise ValueError("motion waveform must start at this model's accepted checkpoint")
    if times[-1] <= times[0] or np.any(np.diff(times) <= 0):
        raise ValueError("motion waveform must have an increasing nonempty time interval")
    if times[-1] > settings["duration"] + 1e-10 or times[-1] - times[0] > settings["windowSize"] + 1e-10:
        raise ValueError("motion waveform exceeds the configured duration or coupling window")
    added = np.zeros((len(model.points), 3, 3))
    inactive = np.ones(model.size, dtype=bool)
    inactive[model.active] = False
    for load in loads:
        if any(np.shape(load[name]) != (len(times), len(model.points), 3) for name in ("forces", "moments")) or np.shape(load["addedMass"]) != (len(model.points), 3, 3):
            raise ValueError("load waveform shapes must agree with its time and node coordinates")
        if load["modelIdentity"] != model.identity or not np.array_equal(load["nodeIds"], model.node_ids) or not np.allclose(load["times"], times, rtol=0, atol=1e-10):
            raise ValueError("load and motion identities, node IDs and sample times must agree")
        if model.physical_node_count is not None and np.any(np.asarray(load["moments"])[:, :model.physical_node_count] != 0):
            raise ValueError("coupled moment on a physical solid node requires the semantic attachment reference node or resultant-transfer")
        generalized_load = np.concatenate((load["forces"], load["moments"]), axis=2).reshape(len(times), -1)
        if np.any(generalized_load[:, inactive] != 0):
            raise ValueError("a coupled force/moment acts on an inactive structural DOF")
        added += load["addedMass"]
    inactive_translation = inactive.reshape(-1, 6)[:, :3]
    if np.any(added[inactive_translation] != 0):
        raise ValueError("coupled added mass acts on an inactive translational DOF")
    if not np.allclose(added, added.transpose(0, 2, 1)) or np.linalg.eigvalsh(added).min(initial=0) < -1e-8:
        raise ValueError("hydrodynamic added mass must be symmetric positive semidefinite")
    mass = base_mass.tolil()
    for node, tensor in enumerate(added):
        mass[6 * node:6 * node + 3, 6 * node:6 * node + 3] += tensor
    mass = mass.tocsr()
    damping = base_damping + settings["dampingMass"] * base_mass
    gravity = np.zeros(model.size)
    gravity.reshape(-1, 6)[:, :3] = model.gravity
    # 부가질량은 실제 물체의 무게가 아니다. 중력에는 구조의 질량만 사용한다.
    constant_force = model.force.ravel() + base_mass @ gravity
    force_wave = np.zeros((len(times), len(model.points), 3))
    moment_wave = np.zeros_like(force_wave)
    for load in loads:
        force_wave += load["forces"]
        moment_wave += load["moments"]
    pitches = np.full(len(times), float(solution.history["pitch"][-1][-1])) if control is None else np.asarray(control["pitch"])
    torques = np.zeros(len(times)) if control is None else np.asarray(control["generatorTorque"])
    if control is not None and (control["modelIdentity"] != model.identity or not np.allclose(control["times"], times, rtol=0, atol=1e-10)):
        raise ValueError("control commands must identify the same mechanical time window")
    pitch_rates = np.gradient(pitches, times)
    pitch_accelerations = np.gradient(pitch_rates, times)
    parameters = {key: parameter(value) for key, value in invocation.config["parameters"].items()}
    if solution.time == 0.0 and (loads or control is not None):
        # 최초 구조 호출에는 아직 공력·수력·제어 artifact가 없습니다. 따라서
        # 첫 연성 구간에서 모든 t=0 하중과 부가질량을 받은 뒤 a(0)를 맞춥니다.
        # Newmark가 잘못된 초기 가속도를 사용하면 첫 dt에 비례하는 가짜 충격이
        # 생깁니다. 매 trial은 같은 u(0), v(0)에서 다시 계산하며 원본은 불변입니다.
        initial_force = constant_force.copy().reshape(-1, 6)
        initial_force[:, :3] += force_wave[0]
        initial_force[:, 3:] += moment_wave[0]
        if model.rotor is not None:
            generator = model.rotor["generatorNode"]
            _, axis_index = revolute_joints(model)[generator]
            coordinate = 6 * generator + 3 + axis_index
            initial_force.ravel()[:] -= torques[0] * spring_gradient(model, solution.orientations, coordinate, -1, 0.)
        solution = initialize_acceleration(model, solution, prepared, K, mass, damping,
                                           initial_force.ravel(), bool(parameters["geometricNonlinear"]),
                                           float(pitches[0]), float(pitch_rates[0]), float(pitch_accelerations[0]),
                                           damping_stiffness=settings["dampingStiffness"])
        # 처음 기록한 무하중 반력/토크를 실제 연성 초기값으로 교체합니다.
        # 이력 한 점을 더 붙이지 않으므로 t=0은 여전히 정확히 한 번만 존재합니다.
        solution.history = {}
        append_history(model, solution, float(pitches[0]), float(torques[0]))
    samples = [solution]
    window_history = []
    reuse_guess = previous_artifact is not None and int(old["couplingIteration"]) > 0
    reference_frames = interface_members(model)["referenceOrientations"] if reuse_guess else None
    # 구간 분할 위치가 바뀌어도 출력의 시간 격자는 항상 t=0에서 시작한다.
    clock_allowance = clock_tolerance(settings)
    next_output = (np.floor((solution.time + clock_allowance) / settings["outputInterval"]) + 1) * settings["outputInterval"]
    for target in times[1:]:
        internal_dt = min(settings["dt"], target - solution.time)
        while solution.time < target - 1e-12:
            dt = min(internal_dt, target - solution.time)
            end = solution.time + dt
            external = constant_force.copy().reshape(-1, 6)
            external[:, :3] += interpolate(times, force_wave, end)
            external[:, 3:] += interpolate(times, moment_wave, end)
            torque = float(interpolate(times, torques, end))
            pitch = float(interpolate(times, pitches, end))
            joint_torques = None if model.rotor is None else {model.rotor["generatorNode"]: -torque}
            initial_guess = None
            if reuse_guess:
                # 이전 파형은 Newton의 출발 자세만 제공한다. 속도·가속도와 재료
                # 이력은 이 trial의 직전 수렴 단계 solution에서 다시 적분한다.
                translations = interpolate(times, np.asarray(old["positions"]), end) - model.points
                rotations = interpolate_orientations(times, old["orientations"], end) @ reference_frames.transpose(0, 2, 1)
                initial_guess = (translations, rotations)
            try:
                candidate = transient_step(model, solution, prepared, K, mass, damping, external.ravel(), dt, pitch, parameters["relativeTolerance"], int(parameters["maxIterations"]), bool(parameters["geometricNonlinear"]), invocation.cancellation, pitch_rate=float(interpolate(times, pitch_rates, end)), pitch_acceleration=float(interpolate(times, pitch_accelerations, end)), damping_stiffness=settings["dampingStiffness"], joint_torques=joint_torques, initial_guess=initial_guess)
            except ValueError as error:
                if "Newmark equilibrium" not in str(error):
                    raise
                internal_dt /= 2
                if internal_dt < settings["dt"] / 128:
                    raise ValueError("structural time step failed after 7 subdivisions") from error
                continue
            solution = candidate
            if end >= next_output - clock_allowance or np.isclose(end, times[-1], rtol=0, atol=clock_allowance):
                window_history.append(history_sample(model, solution, pitch, torque))
                next_output += settings["outputInterval"]
        samples.append(solution)
    append_history(model, solution, samples=window_history)
    iteration = int(old["couplingIteration"]) + 1
    actual = motion_from_samples(model, samples, pitches, iteration)
    errors = []
    for name in ("positions", "velocities", "angularVelocities", "accelerations", "rotorSpeed", "generatorSpeed", "pitch"):
        current, prior = np.asarray(actual[name]), np.asarray(old[name])
        if name == "positions":
            current, prior = current - model.points, prior - model.points
        errors.append(float(np.linalg.norm(current - prior) / max(np.linalg.norm(current), np.linalg.norm(prior), 1e-6)))
    relative_rotations = actual["orientations"] @ np.asarray(old["orientations"]).transpose(0, 1, 3, 2)
    rotation_error = np.asarray([rotation_log(value) for value in relative_rotations.reshape(-1, 3, 3)])
    # 각도는 회전행렬의 SO(3) 거리[rad]로 확인한다. 행렬 성분 평균은 사용하지 않는다.
    errors.append(float(np.max(np.linalg.norm(rotation_error, axis=1), initial=0)))
    signals = {"forces": force_wave, "moments": moment_wave, "pitch": pitches, "torque": torques}
    if previous.metadata.get("trialSignals") is not None:
        for name, value in signals.items():
            prior = np.asarray(previous.metadata["trialSignals"][name])
            errors.append(float(np.linalg.norm(value - prior) / max(np.linalg.norm(value), np.linalg.norm(prior), 1e-6)))
    else:
        errors.append(1.0 if loads or control is not None else 0.0)
    residual = max(errors, default=0.0) if previous_artifact is not None else 0.0
    converged = residual <= settings["couplingTolerance"]
    if not converged and iteration >= settings["maxCouplingIterations"]:
        raise ValueError(f"mechanical waveform coupling failed: residual {residual:g}, iterations {iteration}")
    if converged:
        motion = predict_motion(model, solution, settings)
    else:
        weight = settings["relaxation"]
        # 첫 반복은 설정한 완화계수다. 이후 Aitken Δ²는 두 파형 잔차의
        # 변화로 고정점 반복의 선형 수렴률을 추정한다. 단위마다 척도를 고정해
        # N, m, rad처럼 서로 다른 크기가 가속 계수를 지배하지 않도록 한다.
        # 이는 평형/연성 허용오차를 바꾸지 않으며, 물리 이력도 확정하지 않는다.
        residual_parts = []
        scales = dict(previous.metadata.get("residualScales", {}))
        for name in ("positions", "velocities", "angularVelocities", "accelerations", "rotorSpeed", "generatorSpeed", "pitch"):
            current, prior = np.asarray(actual[name]), np.asarray(old[name])
            if name == "positions":
                current, prior = current - model.points, prior - model.points
            if name not in scales:
                scales[name] = max(np.linalg.norm(current), np.linalg.norm(prior), 1e-6)
            residual_parts.append((current - prior).ravel() / scales[name])
        residual_parts.append(rotation_error.ravel())
        iteration_residual = np.concatenate(residual_parts)
        prior_residual = previous.metadata.get("iterationResidual")
        if prior_residual is not None:
            prior_residual = np.asarray(prior_residual)
            change = iteration_residual - prior_residual
            denominator = change @ change
            if denominator > np.finfo(float).eps * max(prior_residual @ prior_residual, 1e-30):
                weight = float(np.clip(-previous.metadata["relaxation"] * (prior_residual @ change) / denominator, .1, 1.0))
        relaxed = dict(actual)
        for name in ("positions", "velocities", "angularVelocities", "accelerations", "rotorSpeed", "generatorSpeed", "pitch"):
            relaxed[name] = weight * actual[name] + (1 - weight) * np.asarray(old[name])
        # 회전행렬을 성분별 평균하면 직교성을 잃는다. 상대 회전의 로그를 완화한다.
        rotations = np.empty_like(actual["orientations"])
        for t in range(len(times)):
            for node in range(len(model.points)):
                prior = np.asarray(old["orientations"])[t, node]
                rotations[t, node] = rotation_exp(weight * rotation_log(actual["orientations"][t, node] @ prior.T)) @ prior
        relaxed["orientations"] = rotations
        motion = BundleValue("caemble.mechanics/motion@1", relaxed, {**previous.metadata, "trialSignals": signals, "iterationResidual": iteration_residual, "residualScales": scales, "relaxation": weight})
    return solution, motion, residual, converged
