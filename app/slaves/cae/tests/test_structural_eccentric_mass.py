"""편심 보의 질량·중력·운동량은 같은 무게중심 운동을 나타내야 한다.

강체 연결 없이 두 절점의 자세와 병진을 각각 바꾼다. 검증 기준은 행렬을
그대로 다시 조립한 값이 아니라 물리적인 CG 속도, 중력 모멘트, 에너지다.
"""

from copy import deepcopy

import numpy as np
import pytest

from app.solvers.structural_mechanics.analysis import (
    initial_solution,
    initialize_acceleration,
    transient_step,
)
from app.solvers.structural_mechanics.beam import beam_cg_mass, physical_beam_mass
from app.solvers.structural_mechanics.formulation import (
    inertial_response,
    prepare_matrices,
)
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.rotations import rotation_exp, skew


def eccentric_model():
    length, density = 1.6, 2.5  # 길이[m], 단위 길이 질량[kg/m].
    center = np.array([0., .15, -.12])
    central = np.diag([.08, .03, .05])
    reference = rotation_exp([.3, -.2, .1])
    points = np.array([[0., 0., 0.], [length, 0., 0.]]) @ reference.T
    coupling = density * skew(center)
    inertia = central + density * (np.dot(center, center) * np.eye(3) - np.outer(center, center))
    mass = np.block([[density * np.eye(3), -coupling], [coupling, inertia]])
    section = {"stiffness": np.diag([500., 120., 120., 30., 30., 30.]),
               "mass": mass, "frame": reference}
    element = Element("beam2", np.array([0, 1]), {"model": "mechanics.isotropic-elastic@1"}, section)
    model = StructuralModel(np.arange(2), points, [element], np.arange(12), np.empty(0, dtype=int), np.zeros((2, 6)))
    state = initial_solution(model)
    rotation = rotation_exp([.7, -.4, .2])
    current = points @ rotation.T
    current[1] += rotation @ reference @ [0., .025, -.015]
    state.displacement[:, :3] = current - points
    state.orientations[0] = rotation @ rotation_exp([.02, -.01, .01])
    state.orientations[1] = rotation @ rotation_exp([-.01, .015, -.02])
    state.velocity[:] = [[.2, -.1, .3, .4, -.2, .1], [-.1, .15, .2, .35, -.12, .17]]
    return model, state, length, density, center, central, reference


def test_physical_section_mass_recovers_center_and_central_inertia():
    model, _, _, density, center, central, _ = eccentric_model()
    actual = physical_beam_mass(model.elements[0].section["mass"])
    np.testing.assert_allclose(actual[0], density, atol=1e-14)
    np.testing.assert_allclose(actual[1], center, atol=1e-14)
    np.testing.assert_allclose(actual[2], central, atol=1e-14)


@pytest.mark.parametrize("defect", ["translation", "coupling", "inertia"])
def test_finite_rotation_rejects_nonphysical_section_mass(defect):
    model, *_ = eccentric_model()
    mass = model.elements[0].section["mass"].copy()
    if defect == "translation":
        mass[0, 0] *= 1.1
    elif defect == "coupling":
        mass[0, 3] = mass[3, 0] = .01
    else:
        # SPD인 것만으로 충분하지 않다. 회전 관성에는 삼각 부등식도 필요하다.
        mass[3, 3] += 1.
    with pytest.raises(ValueError):
        physical_beam_mass(mass)


def test_deformed_eccentric_beam_has_physical_linear_momentum_and_galilean_energy():
    model, state, length, density, center, _, reference = eccentric_model()
    _, mass, _, prepared = prepare_matrices(model)
    _, moving, _, _, kinetic = inertial_response(model, state.displacement, state.orientations, state.velocity, state.acceleration, prepared, mass, True)
    arms = state.orientations @ (reference @ center)
    cg_velocity = state.velocity[:, :3] + np.cross(state.velocity[:, 3:], arms)
    expected_momentum = density * length / 2 * cg_velocity.sum(axis=0)
    actual_momentum = (moving @ state.velocity.ravel()).reshape(2, 6)[:, :3].sum(axis=0)
    np.testing.assert_allclose(actual_momentum, expected_momentum, rtol=1e-13, atol=1e-13)
    boost = np.array([.7, -.2, .4])
    boosted = state.velocity.copy()
    boosted[:, :3] += boost
    boosted_kinetic = inertial_response(model, state.displacement, state.orientations, boosted, state.acceleration, prepared, mass, True)[4]
    np.testing.assert_allclose(boosted_kinetic, kinetic + boost @ expected_momentum + density * length * (boost @ boost) / 2, rtol=1e-13, atol=1e-13)


def test_deformed_eccentric_beam_gravity_uses_each_nodal_center_of_mass():
    model, state, length, density, center, _, reference = eccentric_model()
    _, mass, _, prepared = prepare_matrices(model)
    gravity = np.array([1., -2., -9.])
    acceleration = np.tile(np.r_[gravity, np.zeros(3)], (2, 1))
    weight = inertial_response(model, state.displacement, state.orientations, np.zeros((2, 6)), acceleration, prepared, mass, True)[0].reshape(2, 6)
    force_per_node = density * length / 2 * gravity
    arms = state.orientations @ (reference @ center)
    np.testing.assert_allclose(weight[:, :3], np.tile(force_per_node, (2, 1)), rtol=1e-13, atol=1e-13)
    np.testing.assert_allclose(weight[:, 3:], np.cross(arms, force_per_node), rtol=1e-13, atol=1e-13)


def test_nonphysical_mass_is_rejected_by_rotating_runtime_but_linear_mass_is_retained():
    model, state, *_ = eccentric_model()
    model.elements[0].section["mass"][0, 0] *= 1.1
    _, mass, _, prepared = prepare_matrices(model)
    state.acceleration[:] = .2
    force, retained, *_ = inertial_response(model, state.displacement, state.orientations, state.velocity, state.acceleration, prepared, mass, False)
    np.testing.assert_array_equal(force, mass @ state.acceleration.ravel())
    np.testing.assert_array_equal(retained.toarray(), mass.toarray())
    with pytest.raises(ValueError, match="translation"):
        inertial_response(model, state.displacement, state.orientations, state.velocity, state.acceleration, prepared, mass, True)


def test_eccentric_mass_directional_derivative_in_general_spatial_motion():
    model, state, *_ = eccentric_model()
    section = model.elements[0].section
    properties = physical_beam_mass(section["mass"])
    moving, derivatives = beam_cg_mass(model.points, state.displacement[:, :3], state.orientations, section["frame"], properties, True)
    direction = np.array([[.13, -.21, .11, -.17, .23, .31], [-.12, .09, .19, .21, -.27, .14]])
    analytic = np.einsum("i,ijk->jk", direction.ravel(), derivatives)
    step = 1e-5
    plus = np.array([rotation_exp(step * row[3:]) @ rotation for row, rotation in zip(direction, state.orientations)])
    minus = np.array([rotation_exp(-step * row[3:]) @ rotation for row, rotation in zip(direction, state.orientations)])
    forward = beam_cg_mass(model.points, state.displacement[:, :3] + step * direction[:, :3], plus, section["frame"], properties)[0]
    backward = beam_cg_mass(model.points, state.displacement[:, :3] - step * direction[:, :3], minus, section["frame"], properties)[0]
    np.testing.assert_allclose(analytic, (forward - backward) / (2 * step), rtol=2e-7, atol=2e-11)
    np.testing.assert_allclose(moving, moving.T, atol=1e-14)
    assert np.linalg.eigvalsh(moving).min() > 0


def test_mixed_centered_batch_and_eccentric_scalar_match_all_scalar_inertia():
    model, state, _, density, _, central, _ = eccentric_model()
    centered = deepcopy(model.elements[0])
    centered.section["mass"] = np.block([[density * np.eye(3), np.zeros((3, 3))], [np.zeros((3, 3)), central]])
    model.elements.append(centered)
    _, mass, _, prepared = prepare_matrices(model)
    scalar = [dict(item) for item in prepared]
    scalar[0].pop("beamBatch")
    state.acceleration[:] = [[.1, -.2, .3, -.1, .2, .1], [-.2, .4, -.1, .3, -.1, .2]]
    batched = inertial_response(model, state.displacement, state.orientations, state.velocity, state.acceleration, prepared, mass, True, True)
    individual = inertial_response(model, state.displacement, state.orientations, state.velocity, state.acceleration, scalar, mass, True, True)
    for left, right in zip(batched, individual):
        if hasattr(left, "toarray"):
            left, right = left.toarray(), right.toarray()
        np.testing.assert_allclose(left, right, rtol=1e-11, atol=1e-12)


def test_eccentric_elastic_motion_under_gravity_converges_in_energy_and_momentum():
    model, initial, length, density, center, _, reference = eccentric_model()
    model.gravity = np.array([.4, -.7, -9.])
    stiffness, mass, damping, prepared = prepare_matrices(model)
    external = mass @ np.tile(np.r_[model.gravity, np.zeros(3)], 2)
    initial = initialize_acceleration(model, initial, prepared, stiffness, mass, damping, external, True)
    errors = []
    for dt in (.01, .005, .0025):
        state = deepcopy(initial)
        totals, centers = [], []
        for index in range(round(.1 / dt) + 1):
            if index:
                state = transient_step(model, state, prepared, stiffness, mass, damping, external, dt, 0., 1e-11, 25, True)
            moving = inertial_response(model, state.displacement, state.orientations, state.velocity, state.acceleration, prepared, mass, True)[1]
            nodal_momentum = (moving @ state.velocity.ravel()).reshape(2, 6)
            positions = model.points + state.displacement[:, :3]
            cg_positions = positions + state.orientations @ (reference @ center)
            potential = -density * length / 2 * np.sum(cg_positions @ model.gravity)
            totals.append((state.strain_energy + state.kinetic_energy + potential,
                           nodal_momentum[:, :3].sum(axis=0),
                           np.sum(np.cross(positions, nodal_momentum[:, :3]) + nodal_momentum[:, 3:], axis=0)))
            centers.append(cg_positions.mean(axis=0))
        initial_energy, initial_linear, initial_angular = totals[0]
        final_energy, final_linear, final_angular = totals[-1]
        torque = np.cross(np.asarray(centers), density * length * model.gravity)
        angular_impulse = np.trapezoid(torque, dx=dt, axis=0)
        errors.append([abs(final_energy - initial_energy),
                       np.linalg.norm(final_linear - initial_linear - .1 * density * length * model.gravity),
                       np.linalg.norm(final_angular - initial_angular - angular_impulse)])
    errors = np.asarray(errors)
    assert np.max(errors[-1]) < 1e-4
    np.testing.assert_array_less(errors[1:], .4 * errors[:-1] + 1e-10)
