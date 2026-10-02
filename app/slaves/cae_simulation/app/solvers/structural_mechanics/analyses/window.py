"""Advance one structural time window; multiphysics ordering belongs to simulate.py."""

import numpy as np

from app.kernel.api import BundleValue

from ..clock import clock_tolerance
from ..constraints import revolute_joints, spring_gradient
from ..domain import parameter
from ..interfaces.motion import (
    interface_members,
    interpolate,
    interpolate_orientations,
    motion_from_samples,
    predict_motion,
)
from app.methods.rigid.rotations import rotation_exp, rotation_log
from ..state import append_history, history_sample
from .transient import initialize_acceleration, transient_step


def advance_window(invocation, model, solution, settings, matrices, *, surface_samples=None):
    prepared = matrices
    K = prepared.stiffness
    base_mass = prepared.mass
    base_damping = prepared.damping
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
    if surface_samples is not None:
        surface_samples.frame_kind = "solved-window"
        surface_samples.times.append(solution.time)
        surface_samples.velocities.append(solution.velocity[surface_samples.nodes, :3].copy())
    window_history = []
    reuse_guess = previous_artifact is not None and int(old["couplingIteration"]) > 0
    reference_frames = interface_members(model)["referenceOrientations"] if reuse_guess else None
    # 구간 분할 위치가 바뀌어도 출력의 시간 격자는 항상 t=0에서 시작한다.
    clock_allowance = clock_tolerance(settings)
    next_output = (np.floor((solution.time + clock_allowance) / settings["outputInterval"]) + 1) * settings["outputInterval"]
    for target in times[1:]:
        internal_dt = min(settings["dt"], target - solution.time)
        while solution.time < target - clock_allowance:
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
            if surface_samples is not None:
                surface_samples.times.append(solution.time)
                surface_samples.velocities.append(solution.velocity[surface_samples.nodes, :3].copy())
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
    if surface_samples is not None:
        surface_samples.coupling_converged = converged
        surface_samples.coupling_iteration = iteration
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
