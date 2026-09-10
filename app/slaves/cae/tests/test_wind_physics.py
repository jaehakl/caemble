"""풍력 물리의 독립 해석식·보존량·checkpoint와 실제 ABI 진입점 검증."""

import math

import numpy as np
import pytest
from scipy.linalg import expm

from app.kernel.api import BundleValue, InputArtifact, SolverInvocation
from app.solvers.aerodynamic_loading.formulation import (
    aerodynamic_response,
    bem_section,
    oye_step,
)
from app.solvers.hydrodynamic_loading.formulation import (
    airy_kinematics,
    hydrodynamic_response,
    wave_numbers,
)
from app.solvers.wind_turbine_control.formulation import (
    control_response,
    generator_torque,
)


def controller_settings():
    # 특정 Catalog turbine 데이터의 사본이 아닌, 단위가 있는 작은 합성 제어기.
    return dict(
        speedFilterFrequency=2.0,
        ratedGeneratorSpeed=10.1,
        ratedMechanicalPower=1000.0,
        region2TorqueConstant=0.9,
        cutInGeneratorSpeed=2.0,
        region2GeneratorSpeed=4.0,
        region3GeneratorSpeed=10.0,
        slipFraction=0.1,
        maximumTorque=120.0,
        maximumTorqueRate=15.0,
        pitchKp=0.1,
        pitchKi=0.2,
        pitchKk=0.1,
        minimumPitch=0.0,
        maximumPitch=1.2,
        region3PitchThreshold=0.02,
        maximumPitchRate=0.1,
        initialPitch=0.0,
        initialGeneratorTorque=0.0,
    )


def motion_history(times, positions, velocity=None, orientation=None):
    times, positions = (
        np.asarray(times, dtype=float),
        np.asarray(positions, dtype=float),
    )
    shape = (len(times), len(positions), 3)
    return {
        "modelIdentity": "test-model",
        "nodeIds": np.arange(len(positions)),
        "times": times,
        "positions": np.broadcast_to(positions, shape),
        "orientations": np.broadcast_to(
            np.eye(3) if orientation is None else orientation, (*shape, 3)
        ),
        "velocities": np.zeros(shape)
        if velocity is None
        else np.broadcast_to(velocity, shape),
        "angularVelocities": np.zeros(shape),
        "accelerations": np.zeros(shape),
        "rotorSpeed": np.full(len(times), 1.0),
        "generatorSpeed": np.full(len(times), 6.0),
        "pitch": np.zeros(len(times)),
        "couplingIteration": 2,
    }


def hydro_problem():
    settings = dict(
        waterDensity=1000.0,
        waterDepth=10.0,
        gravity=9.81,
        currentVelocity=[2.0, 0.0, 0.0],
        waveAmplitudes=[],
        wavePeriods=[],
        waveDirections=[],
        wavePhases=[],
    )
    members = {
        "indices": np.array([[0, 1]]),
        "memberNodes": np.array([[0, 1]]),
        "diameters": np.array([2.0]),
        "dragCoefficients": np.array([1.0]),
        "addedMassCoefficients": np.array([1.0]),
        "pressureCoefficients": np.array([1.0]),
        "buoyancyAreas": np.array([0.0]),
    }
    model = {
        "modelIdentity": "test-model",
        "nodeIds": np.array([0, 1]),
        "referencePositions": np.array([[0.0, 0.0, -10.0], [0.0, 0.0, 0.0]]),
    }
    return (
        settings,
        members,
        model,
        motion_history([0, 0.1, 0.2], model["referencePositions"]),
    )


def aero_problem():
    axis = np.array([1.0, 0.0, 0.0])
    axis.flags.writeable = False
    settings = dict(
        airDensity=1.2,
        rotorRadius=63.0,
        hubRadius=1.5,
        bladeCount=3,
        rotorAxis=axis,
        windTimes=[0, 1],
        windVelocities=[[10, 0, 0], [11, 0, 0]],
        referenceHeight=100.0,
        shearExponent=0.0,
        dynamicInflow=True,
    )
    sections = {
        "indices": np.array([0]),
        "nodeIds": np.array([0]),
        "radii": np.array([30.0]),
        "lengths": np.array([2.0]),
        "chord": np.array([3.0]),
        "twist": np.array([0.05]),
        "polarIndices": np.array([0]),
        "polarAngles": np.linspace(-math.pi, math.pi, 361),
        "liftCoefficients": np.sin(np.linspace(-math.pi, math.pi, 361))[None, :] * 2,
        "dragCoefficients": np.full((1, 361), 0.01),
        "momentCoefficients": np.zeros((1, 361)),
    }
    model = {
        "modelIdentity": "test-model",
        "nodeIds": np.array([0]),
        "referencePositions": np.array([[0.0, 0.0, 100.0]]),
    }
    orientation = np.array([[0.0, 0.0, 1.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]])
    motion = motion_history(
        np.linspace(0, 0.1, 11), model["referencePositions"], [0, -40, 0], orientation
    )
    return settings, sections, model, motion


@pytest.mark.parametrize("chord", [3.0, 10.0])
def test_bem_balances_blade_force_with_momentum_and_buhl(chord):
    a, ap, phi, residual = bem_section(
        10, 40, 30, chord, 0, [-math.pi, math.pi], [1, 1], [0.01, 0.01], 3, 1.5, 63
    )
    sine, cosine = math.sin(phi), math.cos(phi)
    loss = (2 / math.pi * math.acos(math.exp(-3 * (63 - 30) / (2 * 30 * sine)))) * (
        2 / math.pi * math.acos(math.exp(-3 * (30 - 1.5) / (2 * 1.5 * sine)))
    )
    relative_squared = (10 * (1 - a)) ** 2 + (40 * (1 + ap)) ** 2
    blade_ct = (
        3 * chord / (2 * math.pi * 30) * (cosine + 0.01 * sine) * relative_squared / 100
    )
    momentum_ct = (
        4 * loss * a * (1 - a)
        if a <= 0.4
        else 8 / 9 + (4 * loss - 40 / 9) * a + (50 / 9 - 4 * loss) * a * a
    )
    assert blade_ct == pytest.approx(momentum_ct, rel=1e-7)
    assert residual < 1e-8


def test_aerodynamic_center_offset_preserves_force_moment_and_virtual_work():
    settings, sections, model, motion = aero_problem()
    local_offset = np.array([[0.0, 0.7, -0.2]])
    omega = np.broadcast_to([0.3, 0.2, 0.1], motion["velocities"].shape)
    motion = {**motion, "angularVelocities": omega}
    offset_sections = {**sections, "aerodynamicOffsets": local_offset}
    offset_loads, _, _ = aerodynamic_response(settings, offset_sections, model, motion)
    offset = np.einsum("tnij,nj->tni", motion["orientations"], local_offset)
    point_velocity = motion["velocities"] + np.cross(omega, offset)
    point_motion = {
        **motion,
        "positions": motion["positions"] + offset,
        "velocities": point_velocity,
    }
    point_loads, _, _ = aerodynamic_response(settings, sections, model, point_motion)
    np.testing.assert_allclose(
        offset_loads["forces"], point_loads["forces"], atol=1e-12
    )
    np.testing.assert_allclose(
        offset_loads["moments"],
        point_loads["moments"] + np.cross(offset, point_loads["forces"]),
        atol=1e-12,
    )
    power_at_node = np.sum(
        offset_loads["forces"] * motion["velocities"] + offset_loads["moments"] * omega,
        axis=(1, 2),
    )
    power_at_point = np.sum(
        point_loads["forces"] * point_velocity + point_loads["moments"] * omega,
        axis=(1, 2),
    )
    np.testing.assert_allclose(power_at_node, power_at_point, atol=1e-10)


def test_positive_feather_pitch_rotates_leading_edge_upwind_once():
    settings, sections, model, motion = aero_problem()
    pitch = 0.1
    rotation = np.array(motion["orientations"], copy=True)
    old_chord, old_normal = rotation[..., 1].copy(), rotation[..., 2].copy()
    rotation[..., 1] = math.cos(pitch) * old_chord - math.sin(pitch) * old_normal
    rotation[..., 2] = math.sin(pitch) * old_chord + math.cos(pitch) * old_normal
    pitched = {
        **motion,
        "orientations": rotation,
        "pitch": np.full(len(motion["times"]), pitch),
    }
    actual, _, _ = aerodynamic_response(settings, sections, model, pitched)
    equivalent, _, _ = aerodynamic_response(
        settings, {**sections, "twist": sections["twist"] + pitch}, model, motion
    )
    np.testing.assert_allclose(
        actual["forces"], equivalent["forces"], rtol=1e-12, atol=1e-12
    )


@pytest.mark.parametrize("radius", [1.5, 63.0])
def test_prandtl_endpoints_keep_airfoil_force_at_fixed_induction(radius):
    settings, sections, model, motion = aero_problem()
    sections = {**sections, "radii": np.array([radius])}
    loads, _, _ = aerodynamic_response(settings, sections, model, motion)
    # 끝점의 축 상대 속도는 0이지만 회전 속도와 음의 받음각으로 힘이 남는다.
    alpha = -sections["twist"][0]
    cl = np.interp(alpha, sections["polarAngles"], sections["liftCoefficients"][0])
    q = (
        0.5
        * settings["airDensity"]
        * 40**2
        * sections["chord"][0]
        * sections["lengths"][0]
    )
    assert loads["forces"][0, 0, 0] == pytest.approx(q * cl)
    assert loads["forces"][0, 0, 0] != 0


def test_oye_exact_step_matches_independent_matrix_exponential():
    reduced, induced, quasi = (
        np.array([0.2, 0.1]),
        np.array([0.4, -0.1]),
        np.array([1.2, 0.3]),
    )
    actual_reduced, actual_induced = oye_step(reduced, induced, quasi, 0.3, 2.0, 0.6)
    matrix = np.array([[-0.5, 0], [1 / 0.6, -1 / 0.6]])
    equilibrium = np.vstack((0.4 * quasi, quasi))
    expected = equilibrium + expm(0.3 * matrix) @ (
        np.vstack((reduced, induced)) - equilibrium
    )
    np.testing.assert_allclose(actual_reduced, expected[0], atol=1e-14)
    np.testing.assert_allclose(actual_induced, expected[1], atol=1e-14)


def test_airy_dispersion_acceleration_and_seabed_boundary():
    depth, period, amplitude = 20.0, 8.0, 1.5
    number = wave_numbers([period], depth, 9.81)[0]
    assert 9.81 * number * math.tanh(number * depth) == pytest.approx(
        (2 * math.pi / period) ** 2, rel=1e-12
    )
    args = ([amplitude], [period], [0.4], [0.2], depth)
    position, time, dt = np.array([2.0, 3.0, -5.0]), 1.2, 1e-5
    _, acceleration = airy_kinematics(position, time, *args)
    before = airy_kinematics(position, time - dt, *args)[0]
    after = airy_kinematics(position, time + dt, *args)[0]
    np.testing.assert_allclose((after - before) / (2 * dt), acceleration, rtol=1e-8)
    assert airy_kinematics([0, 0, -depth], time, *args)[0][2] == pytest.approx(0)
    assert np.all(
        np.isfinite(airy_kinematics([0, 0, -10], 0, [1], [1], [0], [0], 10000)[0])
    )


def test_morison_total_force_moment_added_mass_and_relative_drag():
    settings, members, model, motion = hydro_problem()
    loads, _, _ = hydrodynamic_response(settings, members, model, motion)
    total = loads["forces"].sum(axis=1)
    np.testing.assert_allclose(total, np.tile([40000.0, 0.0, 0.0], (3, 1)), atol=1e-9)
    moment = np.cross(model["referencePositions"], loads["forces"][0]).sum(axis=0)
    np.testing.assert_allclose(moment, [0, -200000, 0], atol=1e-8)
    np.testing.assert_allclose(
        loads["addedMass"].sum(axis=0),
        np.diag([10000 * math.pi, 10000 * math.pi, 0]),
        atol=1e-10,
    )
    assert np.min(np.linalg.eigvalsh(loads["addedMass"])) >= 0
    motion["velocities"] = np.broadcast_to([0.5, 0, 0], (3, 2, 3))
    motion["accelerations"] = np.full((3, 2, 3), 1e6)
    moving, _, _ = hydrodynamic_response(settings, members, model, motion)
    assert moving["forces"][0, :, 0].sum() == pytest.approx(22500)
    # 가속도를 바꿔도 외력은 같아야 한다. -Ma*a는 구조 방정식의 왼쪽에 있다.
    motion["accelerations"] = np.zeros((3, 2, 3))
    other, _, _ = hydrodynamic_response(settings, members, model, motion)
    np.testing.assert_array_equal(moving["forces"], other["forces"])


def test_hydro_clips_reference_wet_length_and_has_no_dry_added_mass():
    settings, members, model, motion = hydro_problem()
    model["referencePositions"] = np.array([[0.0, 0.0, -20.0], [0.0, 0.0, 10.0]])
    motion["positions"] = np.broadcast_to(model["referencePositions"], (3, 2, 3))
    loads, _, _ = hydrodynamic_response(settings, members, model, motion)
    assert loads["forces"][0, :, 0].sum() == pytest.approx(40000)
    assert loads["addedMass"][:, 0, 0].sum() == pytest.approx(10000 * math.pi)


def test_controller_regions_and_limits():
    settings = controller_settings()
    assert generator_torque(1, 0, settings) == 0
    assert generator_torque(6, 0, settings) == pytest.approx(0.9 * 36)
    assert generator_torque(20, 0.1, settings) == pytest.approx(50)
    assert generator_torque(1, 0.1, settings) == settings["maximumTorque"]
    assert generator_torque(4 - 1e-8, 0, settings) == pytest.approx(
        generator_torque(4 + 1e-8, 0, settings), rel=1e-7
    )
    motion = {
        "modelIdentity": "test-model",
        "times": np.linspace(0, 5, 501),
        "generatorSpeed": np.full(501, 14.0),
    }
    commands, state, _ = control_response(settings, motion)
    assert (
        np.max(np.abs(np.diff(commands["pitch"]) / 0.01))
        <= settings["maximumPitchRate"] + 1e-12
    )
    assert (
        np.max(np.abs(np.diff(commands["generatorTorque"]) / 0.01))
        <= settings["maximumTorqueRate"] + 1e-10
    )
    assert 0 < commands["pitch"][-1] <= settings["maximumPitch"]
    assert state["filteredGeneratorSpeed"] == pytest.approx(14)


@pytest.mark.parametrize("physics", ["aero", "control"])
def test_wind_checkpoint_split_and_repeated_trials_are_identical(physics):
    if physics == "aero":
        settings, sections, model, motion = aero_problem()
        solve = lambda history, state=None: aerodynamic_response(
            settings, sections, model, history, state
        )
        key = "forces"
    else:
        settings = controller_settings()
        motion = {
            "modelIdentity": "test-model",
            "times": np.linspace(0, 1, 11),
            "generatorSpeed": np.linspace(5, 14, 11),
        }
        solve = lambda history, state=None: control_response(settings, history, state)
        key = "pitch"
    all_result, all_state, _ = solve(motion)
    history_fields = {
        "times",
        "positions",
        "orientations",
        "velocities",
        "angularVelocities",
        "accelerations",
        "rotorSpeed",
        "generatorSpeed",
        "pitch",
    }
    first_motion = {
        name: value[:6] if name in history_fields else value
        for name, value in motion.items()
    }
    second_motion = {
        name: value[5:] if name in history_fields else value
        for name, value in motion.items()
    }
    first, checkpoint, _ = solve(first_motion)
    second, resumed, _ = solve(second_motion, checkpoint)
    repeated, _, _ = solve(second_motion, checkpoint)
    np.testing.assert_allclose(
        np.concatenate((first[key], second[key][1:])), all_result[key], atol=1e-12
    )
    np.testing.assert_array_equal(repeated[key], second[key])
    assert resumed["time"] == all_state["time"]


@pytest.mark.asyncio
@pytest.mark.parametrize("physics", ["aero", "hydro", "control"])
async def test_wind_abi_entries_preserve_task_state_and_typed_outputs(physics):
    from app.solvers.aerodynamic_loading.entry import run as run_aero
    from app.solvers.hydrodynamic_loading.entry import run as run_hydro
    from app.solvers.wind_turbine_control.entry import run as run_control

    if physics == "aero":
        settings, initialization, model, motion = aero_problem()
        run, package, init_method, output_method, output_type = (
            run_aero,
            "aerodynamic_loading",
            "aero.blade-sections",
            "aero.loads",
            "loads",
        )
    elif physics == "hydro":
        settings, initialization, model, motion = hydro_problem()
        run, package, init_method, output_method, output_type = (
            run_hydro,
            "hydrodynamic_loading",
            "hydro.members",
            "hydro.loads",
            "loads",
        )
    else:
        settings, initialization = controller_settings(), {}
        model = {"modelIdentity": "test-model", "nodeIds": np.array([0])}
        motion = motion_history([0, 0.1, 0.2], [[0, 0, 10]])
        run, package, init_method, output_method, output_type = (
            run_control,
            "wind_turbine_control",
            "control.baseline",
            "control.commands",
            "control",
        )
    inputs = {
        key: InputArtifact(
            key,
            f"caemble.mechanics/{kind}@1",
            "structure",
            "structural-mechanics",
            "1.0.0",
            key,
            1,
            None,
            BundleValue(f"caemble.mechanics/{kind}@1", value),
        )
        for key, kind, value in (
            ("model", "interface", model),
            ("motion", "motion", motion),
        )
    }
    config = {
        "parameters": {key: {"value": value} for key, value in settings.items()},
        "initializations": [
            {
                "methodId": init_method,
                "parameters": {
                    key: {"value": value}
                    for key, value in initialization.items()
                    if key != "indices"
                },
            }
        ],
        "outputs": [{"methodId": output_method, "key": "result"}],
    }
    original = {"other": {"unchanged": 17}}
    invocation = SolverInvocation(
        config, original, inputs, {}, None, None, {}, task_name="physics-task"
    )
    result = await run(invocation)
    assert (
        result.artifacts["result"].bundle_type == f"caemble.mechanics/{output_type}@1"
    )
    assert result.state_patch.operations[-1].path == (package, "physics-task")
    assert original == {"other": {"unchanged": 17}}
    # 실제 런타임에 commit해야 중간 namespace 누락도 검출할 수 있다.
    from app.kernel.resources import StateStore
    from dataclasses import replace

    states = StateStore()
    try:
        base = states.replace(None, original)
        accepted = states.commit(base, result.state_patch)
        assert accepted["other"]["unchanged"] == 17
        assert accepted[package]["physics-task"]["time"] == motion["times"][-1]
        another = await run(
            replace(invocation, state=states.view(accepted), task_name="another-task")
        )
        final = states.commit(accepted, another.state_patch)
        assert final[package]["physics-task"]["time"] == motion["times"][-1]
        assert final[package]["another-task"]["time"] == motion["times"][-1]
        assert len(another.state_patch.operations) == 1
    finally:
        states.close()
