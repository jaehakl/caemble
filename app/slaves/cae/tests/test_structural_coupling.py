"""힘/모멘트 전달, 부가질량, checkpoint 재계산의 물리적 계약을 검증한다."""

from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api import BundleValue
from app.solvers.structural_mechanics.analysis import initial_solution
from app.solvers.structural_mechanics.constraints import constraint_transform
from app.solvers.structural_mechanics.coupling import (
    advance_window,
    apply_resultant_loads,
    predict_motion,
)
from app.solvers.structural_mechanics.formulation import prepare_matrices
from app.solvers.structural_mechanics.model import StructuralModel
from app.solvers.structural_mechanics.rotations import rotation_exp
from app.solvers.structural_mechanics.state import (
    append_history,
    encode_state,
    read_state,
)


def translation_case():
    model = StructuralModel(np.array([42]), np.zeros((1, 3)), [], np.array([0]), np.empty(0, dtype=int), np.zeros((1, 6)), identity="mass-test")
    model.masses = [(0, 2., np.zeros((3, 3)))]
    model.gravity = np.array([9., 0., 0.])
    solution = initial_solution(model)
    solution.time = 1.
    solution.acceleration[0, 0] = 18. / 5.
    append_history(model, solution)
    settings = {"dt": .01, "windowSize": .02, "duration": 2., "outputInterval": .01, "dampingMass": 0., "dampingStiffness": 0., "couplingTolerance": 1e-4, "maxCouplingIterations": 12, "relaxation": .5}
    times = np.array([1., 1.01, 1.02])
    load = BundleValue("caemble.mechanics/loads@1", {"modelIdentity": model.identity, "nodeIds": model.node_ids.astype(np.int32), "times": times, "forces": np.zeros((3, 1, 3)), "moments": np.zeros((3, 1, 3)), "addedMass": np.array([np.diag([3., 0., 0.])]), "couplingIteration": np.asarray(0, dtype=np.int32)})
    invocation = SimpleNamespace(inputs={"loads": (SimpleNamespace(value=load),)}, config={"parameters": {"relativeTolerance": 1e-10, "maxIterations": 10, "geometricNonlinear": False}}, cancellation=None)
    return model, solution, settings, invocation


def test_added_mass_is_assembled_once_and_does_not_add_gravity_weight():
    model, solution, settings, invocation = translation_case()
    result, _, residual, converged = advance_window(invocation, model, solution, settings, prepare_matrices(model))
    acceleration = 2 * 9 / (2 + 3)
    np.testing.assert_allclose(result.acceleration[0, 0], acceleration, rtol=1e-12)
    np.testing.assert_allclose(result.velocity[0, 0], acceleration * .02, rtol=1e-12)
    np.testing.assert_allclose(result.displacement[0, 0], .5 * acceleration * .02**2, rtol=1e-12)
    assert converged and residual == 0


def test_same_checkpoint_recalculation_and_rejected_trials_do_not_accumulate_history():
    model, solution, settings, invocation = translation_case()
    saved = deepcopy(encode_state(model, solution))
    first = advance_window(invocation, model, read_state(model, saved), settings, prepare_matrices(model))[0]
    second = advance_window(invocation, model, read_state(model, saved), settings, prepare_matrices(model))[0]
    np.testing.assert_array_equal(first.displacement, second.displacement)
    np.testing.assert_array_equal(first.velocity, second.velocity)
    assert sum(len(chunk) for chunk in first.history["times"]) == sum(len(chunk) for chunk in second.history["times"]) == 3
    assert len(first.history["times"]) == 2  # 초기 표본 + 한 시간 구간의 packed chunk
    assert len(saved["history"]["times"]) == 1
    np.testing.assert_array_equal(saved["displacement"], 0.)


def test_first_coupled_window_initializes_acceleration_from_full_load_and_added_mass():
    model, solution, settings, invocation = translation_case()
    solution.time = 0.
    solution.acceleration[:] = 0.
    solution.history = {}
    append_history(model, solution)
    load = invocation.inputs["loads"][0].value.members
    load["times"] = np.array([0., .01, .02])
    load["forces"][:, 0, 0] = 10.
    saved = deepcopy(encode_state(model, solution))
    result = advance_window(invocation, model, solution, settings, prepare_matrices(model))[0]
    acceleration = (2 * 9 + 10) / (2 + 3)
    np.testing.assert_allclose(result.acceleration[0, 0], acceleration, rtol=1e-12)
    np.testing.assert_allclose(result.velocity[0, 0], acceleration * .02, rtol=1e-12)
    np.testing.assert_allclose(result.displacement[0, 0], .5 * acceleration * .02**2, rtol=1e-12)
    np.testing.assert_array_equal(np.concatenate(result.history["times"]), [0., .01, .02])
    np.testing.assert_array_equal(solution.acceleration, saved["acceleration"])
    np.testing.assert_array_equal(solution.history["times"][0], saved["history"]["times"][0])


def test_coupling_exhaustion_fails_without_mutating_checkpoint():
    model, solution, settings, invocation = translation_case()
    previous = predict_motion(model, solution, settings)
    invocation.inputs["previousMotion"] = SimpleNamespace(value=previous)
    settings["maxCouplingIterations"] = 1
    before = deepcopy(solution)
    with pytest.raises(ValueError, match="waveform coupling failed"):
        advance_window(invocation, model, solution, settings, prepare_matrices(model))
    np.testing.assert_array_equal(solution.displacement, before.displacement)
    assert len(solution.history["times"]) == 1


def test_incompatible_model_and_negative_added_mass_are_rejected():
    model, solution, settings, invocation = translation_case()
    with pytest.raises(ValueError, match="different mesh"):
        read_state(model, {**encode_state(model, solution), "modelIdentity": "foreign"})
    invocation.inputs["loads"][0].value.members["addedMass"][0, 0, 0] = -1.
    with pytest.raises(ValueError, match="positive semidefinite"):
        advance_window(invocation, model, solution, settings, prepare_matrices(model))


def test_finite_rotation_rigid_link_preserves_resultant_and_virtual_work():
    points = np.array([[0., 0., 0.], [2., 1., -.3]])
    model = StructuralModel(np.array([1, 2]), points, [], np.arange(12), np.empty(0, dtype=int), np.zeros((2, 6)))
    model.links = [(0, 1, np.arange(6))]
    R = np.tile(rotation_exp(np.array([.6, -.3, .2])), (2, 1, 1))
    transform = constraint_transform(model, R)
    forces = np.array([1., -2., 3., 4., 5., -6., 7., 8., -9., 10., -11., 12.])
    resultant = transform.T @ forces
    np.testing.assert_allclose(resultant[:3], forces[:3] + forces[6:9])
    np.testing.assert_allclose(resultant[3:], forces[3:6] + forces[9:] + np.cross(R[0] @ points[1], forces[6:9]))
    virtual_motion = np.array([.01, -.02, .03, .04, -.05, .06])
    np.testing.assert_allclose(forces @ (transform @ virtual_motion), resultant @ virtual_motion)


def test_coupled_loads_on_missing_dofs_are_rejected_instead_of_discarded():
    model, solution, settings, invocation = translation_case()
    load = invocation.inputs["loads"][0].value.members
    load["moments"][:, 0, 2] = 1.
    with pytest.raises(ValueError, match="inactive structural DOF"):
        advance_window(invocation, model, solution, settings, prepare_matrices(model))
    load["moments"][:] = 0
    load["addedMass"][0, 1, 1] = 1.
    with pytest.raises(ValueError, match="inactive translational DOF"):
        advance_window(invocation, model, solution, settings, prepare_matrices(model))


def test_detailed_submodel_preserves_eccentric_force_moment_and_virtual_work():
    points = np.array([[2., -1., 0.], [2., 1., 0.], [2., 0., 1.]])
    model = StructuralModel(np.array([10, 11, 12]), points, [], np.arange(18), np.empty(0, dtype=int), np.zeros((3, 6)))
    motion = BundleValue("caemble.mechanics/motion@1", {"modelIdentity": "whole-system", "nodeIds": np.array([5]), "times": np.array([1.]), "positions": np.array([[[4., .5, 2.]]])})
    load = BundleValue("caemble.mechanics/loads@1", {"modelIdentity": "whole-system", "nodeIds": np.array([5]), "times": np.array([1.]), "forces": np.array([[[3., 4., 5.]]]), "moments": np.array([[[6., 7., 8.]]])})
    reference = np.array([2., 0., 0.])
    invocation = SimpleNamespace(inputs={"sourceLoads": (SimpleNamespace(value=load),), "sourceMotion": SimpleNamespace(value=motion)}, config={"boundaryConditions": [{"methodId": "fea.resultant-transfer", "parameters": {"sourceNodeIds": [5], "targetNodeIds": [10, 11, 12], "referencePoint": reference}}]})
    apply_resultant_loads(invocation, model)
    expected_force = np.array([3., 4., 5.])
    expected_moment = np.array([6., 7., 8.]) + np.cross(np.array([4., .5, 2.]) - reference, expected_force)
    np.testing.assert_allclose(model.force[:, :3].sum(axis=0), expected_force)
    np.testing.assert_allclose(np.cross(points - reference, model.force[:, :3]).sum(axis=0), expected_moment)
    du, theta = np.array([.02, .03, -.04]), np.array([.06, -.02, .03])
    work = np.sum(model.force[:, :3] * (du + np.cross(theta, points - reference)))
    np.testing.assert_allclose(work, expected_force @ du + expected_moment @ theta)


def test_final_predictor_stops_at_duration_and_rotation_frames_stay_orthonormal():
    model, solution, settings, _ = translation_case()
    settings["duration"] = 1.013
    solution.velocity[0, 3:] = [.8, .3, -.5]
    motion = predict_motion(model, solution, settings).members
    assert motion["times"][-1] == settings["duration"]
    frames = motion["orientations"]
    np.testing.assert_allclose(frames @ frames.transpose(0, 1, 3, 2), np.broadcast_to(np.eye(3), frames.shape), atol=1e-14)
