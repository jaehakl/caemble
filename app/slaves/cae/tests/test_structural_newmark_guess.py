"""Newton 출발 추정의 재사용은 적분 경로나 checkpoint를 바꾸지 않는다."""

from copy import deepcopy

import numpy as np
import pytest

from app.kernel.api import BundleValue
from app.solvers.structural_mechanics import analysis, coupling
from app.solvers.structural_mechanics.analysis import (
    initialize_acceleration,
    static_analysis,
    transient_step,
)
from app.solvers.structural_mechanics.coupling import (
    advance_window,
    interpolate_orientations,
    predict_motion,
)
from app.solvers.structural_mechanics.formulation import prepare_matrices
from app.solvers.structural_mechanics.materials import isotropic_elasticity
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.rotations import (
    rotation_exp,
    rotation_exp_many,
    rotation_log,
)
from tests.test_structural_coupling import translation_case
from tests.test_structural_joints import joint_model
from tests.test_structural_rotation_dynamics import loaded_rotating_beam


@pytest.mark.parametrize("dt", [.1, .02, .005])
def test_warm_exact_multiaxis_pose_is_the_same_newmark_solution(dt):
    model, initial, (K, M, C, prepared), force, beta = loaded_rotating_beam(True)
    saved = deepcopy(initial)
    cold = transient_step(model, initial, prepared, K, M, C, force.ravel(), dt, 0., 1e-10, 20, True, damping_stiffness=beta)
    warm = transient_step(model, initial, prepared, K, M, C, force.ravel(), dt, 0., 1e-10, 20, True, damping_stiffness=beta, initial_guess=(cold.displacement[:, :3], cold.orientations))
    assert warm.iterations == 1 < cold.iterations
    for field in ("displacement", "orientations", "velocity", "acceleration", "reaction"):
        expected, actual = getattr(cold, field), getattr(warm, field)
        assert np.linalg.norm(expected - actual) / max(np.linalg.norm(expected), 1.) < 1e-10
        np.testing.assert_array_equal(getattr(initial, field), getattr(saved, field))
    assert warm.residual <= 1e-10


def test_different_rotation_iteration_paths_converge_to_the_same_physical_state():
    model, initial, (K, M, C, prepared), force, _ = loaded_rotating_beam(False)
    cold = transient_step(model, initial, prepared, K, M, C, force.ravel(), .02, 0., 1e-10, 20, True)
    rng = np.random.default_rng(26)
    for scale in (.001, -.003):
        guess = (cold.displacement[:, :3] + scale * rng.normal(size=(3, 3)), rotation_exp_many(scale * rng.normal(size=(3, 3))) @ cold.orientations)
        warm = transient_step(model, initial, prepared, K, M, C, force.ravel(), .02, 0., 1e-10, 20, True, initial_guess=guess)
        for field in ("displacement", "orientations", "velocity", "acceleration"):
            expected, actual = getattr(cold, field), getattr(warm, field)
            assert np.linalg.norm(expected - actual) / max(np.linalg.norm(expected), 1.) < 1e-10


def test_bad_guess_falls_back_to_predictor_without_mutating_state(monkeypatch):
    model, initial, (K, M, C, prepared), force, _ = loaded_rotating_beam(False)
    cold = transient_step(model, initial, prepared, K, M, C, force.ravel(), .02, 0., 1e-10, 20, True)
    saved = deepcopy(initial)
    calls = []
    original = analysis._newmark_step
    def observed(*args, **kwargs):
        calls.append(kwargs.get("initial_guess") is not None)
        return original(*args, **kwargs)
    monkeypatch.setattr(analysis, "_newmark_step", observed)
    # 모든 절점을 같은 위치로 만드는 추정은 보의 길이가 0이므로 계산 불가다.
    warm = transient_step(model, initial, prepared, K, M, C, force.ravel(), .02, 0., 1e-10, 20, True, initial_guess=(-model.points, initial.orientations))
    assert calls == [True, False]
    np.testing.assert_array_equal(warm.displacement, cold.displacement)
    np.testing.assert_array_equal(warm.orientations, cold.orientations)
    np.testing.assert_array_equal(initial.displacement, saved.displacement)
    np.testing.assert_array_equal(initial.acceleration, saved.acceleration)


def test_warm_revolute_guess_preserves_unwrapped_angle_on_a_tilted_axis():
    model = joint_model()
    model.fixed = np.arange(6)
    model.masses = [(1, 1., np.eye(3) * .1), (2, 2., np.zeros((3, 3)))]
    K, M, C, prepared = prepare_matrices(model)
    initial = analysis.initial_solution(model)
    initial.orientations[0] = rotation_exp([.2, .8, -.4])
    initial.displacement[1, 3] = 8.
    initial.velocity[1, 3:] = 3. * initial.orientations[0][:, 0]
    initial = initialize_acceleration(model, initial, prepared, K, M, C, np.zeros(18), True)
    cold = transient_step(model, initial, prepared, K, M, C, np.zeros(18), .03, 0., 1e-10, 20, True, joint_torques={1: .2})
    warm = transient_step(model, initial, prepared, K, M, C, np.zeros(18), .03, 0., 1e-10, 20, True, joint_torques={1: .2}, initial_guess=(cold.displacement[:, :3], cold.orientations))
    assert warm.displacement[1, 3] > 8.09
    np.testing.assert_allclose(warm.displacement, cold.displacement, rtol=1e-12, atol=1e-13)
    np.testing.assert_allclose(warm.orientations, cold.orientations, atol=1e-13)
    np.testing.assert_allclose(warm.velocity, cold.velocity, rtol=1e-10, atol=1e-11)


def test_warm_plastic_step_uses_only_committed_material_history():
    points = np.array([[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.], [0., 0., 1.], [1., 0., 1.], [1., 1., 1.], [0., 1., 1.]])
    material = {"model": "mechanics.j2-plasticity@1", "E": 1000., "nu": .3, "density": 1., "yieldStress": 2., "hardening": 50., "C": isotropic_elasticity(1000., .3)}
    active = (6 * np.arange(8)[:, None] + np.arange(3)).ravel()
    fixed = np.array([6 * i + axis for i, xyz in enumerate(points) for axis in range(3) if xyz[axis] == 0])
    model = StructuralModel(np.arange(8), points, [Element("hex8", np.arange(8), material)], active, fixed, np.zeros((8, 6)))
    model.force[points[:, 0] == 1, 0] = 3 / 4
    K, M, C, prepared = prepare_matrices(model)
    initial = static_analysis(model, prepared, K, M, tolerance=1e-10)
    initial = initialize_acceleration(model, initial, prepared, K, M, C, model.force.ravel())
    saved = deepcopy(initial.element_history)
    force = 1.2 * model.force.ravel()
    cold = transient_step(model, initial, prepared, K, M, C, force, .01, 0., 1e-10, 20, False)
    warm = transient_step(model, initial, prepared, K, M, C, force, .01, 0., 1e-10, 20, False, initial_guess=(2 * cold.displacement[:, :3], cold.orientations))
    assert np.min(cold.element_history[0]["equivalentPlasticStrain"] - saved[0]["equivalentPlasticStrain"]) > 0
    for key in saved[0]:
        np.testing.assert_array_equal(initial.element_history[0][key], saved[0][key])
        np.testing.assert_allclose(warm.element_history[0][key], cold.element_history[0][key], rtol=1e-10, atol=1e-12)
    np.testing.assert_allclose(warm.displacement, cold.displacement, rtol=1e-10, atol=1e-12)


def test_orientation_interpolation_uses_a_rotation_path_at_adaptive_substeps():
    left = rotation_exp([.8, -.3, .4])
    change = np.array([.3, -.7, .2])
    right = rotation_exp(change) @ left
    samples = np.array([[left], [right]])
    actual = interpolate_orientations(np.array([0., .1]), samples, .025)[0]
    np.testing.assert_allclose(actual, rotation_exp(.25 * change) @ left, atol=1e-14)
    np.testing.assert_allclose(actual @ actual.T, np.eye(3), atol=1e-14)


def test_previous_waveform_guess_is_used_only_after_a_completed_trial(monkeypatch):
    from types import SimpleNamespace
    model, solution, settings, invocation = translation_case()
    previous = predict_motion(model, solution, settings)
    original = coupling.transient_step
    guessed = []
    def observed(*args, **kwargs):
        guessed.append(kwargs.get("initial_guess") is not None)
        return original(*args, **kwargs)
    monkeypatch.setattr(coupling, "transient_step", observed)
    invocation.inputs["previousMotion"] = SimpleNamespace(value=previous)
    cold = advance_window(invocation, model, solution, settings, prepare_matrices(model))[0]
    assert guessed == [False, False]
    guessed.clear()
    members = dict(previous.members)
    members["couplingIteration"] = np.asarray(1, dtype=np.int32)
    invocation.inputs["previousMotion"] = SimpleNamespace(value=BundleValue("caemble.mechanics/motion@1", members, previous.metadata))
    warm, _, _, converged = advance_window(invocation, model, solution, settings, prepare_matrices(model))
    assert not converged  # 거절된 trial도 입력 이력을 변경하지 않는다.
    assert guessed == [True, True]
    np.testing.assert_allclose(warm.displacement, cold.displacement, atol=1e-14)
    assert sum(map(len, warm.history["times"])) == sum(map(len, cold.history["times"])) == 3
    assert sum(map(len, solution.history["times"])) == 1


@pytest.mark.parametrize("phi", [[0., 0., 0.], [1e-7, -2e-7, 3e-7], [.4, -.8, .3]])
def test_predictor_rotation_coordinate_jacobian_matches_spatial_finite_difference(phi):
    phi = np.asarray(phi)
    predictor = rotation_exp([1., -.2, .7])
    direction = np.array([.3, -.4, .2])
    h = 1e-6
    plus = rotation_exp(phi + h * direction) @ predictor
    minus = rotation_exp(phi - h * direction) @ predictor
    physical = rotation_log(plus @ minus.T) / (2 * h)
    jacobian = analysis._rotation_coordinate_jacobians(phi[None])[0]
    np.testing.assert_allclose(jacobian @ physical, direction, rtol=1e-9, atol=1e-10)
