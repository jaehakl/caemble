"""외부 지지 반력과 평면 두께 응력은 실제 힘 평형/재료 조건으로 확인한다."""

import numpy as np
import pytest

from app.kernel.catalog import solver_catalog
from app.kernel.resources import ResourceStore
from app.solvers.structural_mechanics.analysis import (
    initial_solution,
    initialize_acceleration,
    static_analysis,
    transient_step,
)
from app.solvers.structural_mechanics.continuum import element_response
from app.solvers.structural_mechanics.formulation import prepare_matrices
from app.solvers.structural_mechanics.materials import isotropic_elasticity
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.outputs import build_outputs
from app.solvers.structural_mechanics.rotations import rotation_exp
from app.solvers.structural_mechanics.shells import laminate_section, shell4_response


@pytest.mark.parametrize("kind", ["tri3", "quad4"])
@pytest.mark.parametrize("plane", ["stress", "strain"])
def test_public_plane_stress_recovers_the_thickness_constraint_reaction(kind, plane):
    points = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]) if kind == "tri3" else np.array([[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]])
    count = len(points)
    material = {"model": "mechanics.isotropic-elastic@1", "E": 1000., "nu": .3, "density": 1., "C": isotropic_elasticity(1000., .3)}
    element = Element(kind, np.arange(count), material, {"thickness": .2, "plane": plane})
    model = StructuralModel(np.arange(count), points, [element], (6 * np.arange(count)[:, None] + np.arange(2)).ravel(), np.empty(0, dtype=int), np.zeros((count, 6)), identity="plane-output-test")
    solution = initial_solution(model)
    solution.displacement[:, 0] = .01 * points[:, 0]
    solution.stresses[0] = element_response(kind, points[:, :2], solution.displacement[:, :2].ravel(), material["C"], .2, plane)[1]
    config = {"outputs": [{"methodId": "fea.stress", "key": "stress", "parameters": {}}]}
    artifact = build_outputs(config, solver_catalog.descriptor("structural-mechanics", "1.0.0"), model, solution)["stress"]
    actual = artifact.members["stress"]["value"]
    if plane == "strain":
        # epsilon_zz=0으로 가둔 두께의 Poisson 반응: sigma_zz=nu*(sigma_xx+sigma_yy).
        expected = np.array([175 / 13, 75 / 13, 75 / 13, 0., 0., 0.])
    else:
        expected = np.array([1000 / 91, 300 / 91, 0., 0., 0., 0.])
    np.testing.assert_allclose(actual, np.broadcast_to(expected, np.shape(actual)), rtol=1e-13, atol=1e-13)
    np.testing.assert_array_equal(artifact.members["stressBasis"]["value"], np.broadcast_to(np.eye(3), (len(actual), 3, 3)))


def test_tilted_shell_stress_basis_preserves_the_physical_tensor_through_public_transport():
    rotation = rotation_exp([.35, -.62, .4])
    reference = np.array([[0., 0., 0.], [2., 0., 0.], [2., 1., 0.], [0., 1., 0.]])
    points = reference @ rotation.T
    material = {"model": "mechanics.isotropic-elastic@1", "E": 1000., "nu": .3, "density": 1., "C": isotropic_elasticity(1000., .3)}
    section = laminate_section([{"elasticity": material["C"], "G13": 1000. / 2.6, "G23": 1000. / 2.6, "density": 1., "thickness": .1}])
    model = StructuralModel(np.arange(4), points, [Element("shell4", np.arange(4), material, section)], np.arange(24), np.empty(0, dtype=int), np.zeros((4, 6)), identity="tilted-shell-output-test")
    solution = initial_solution(model)
    solution.displacement[:, :3] = .01 * reference[:, :1] * rotation[:, 0]
    solution.stresses[0] = shell4_response(points, solution.displacement.ravel(), section)
    config = {"outputs": [{"methodId": "fea.stress", "key": "stress", "parameters": {}}]}
    field = build_outputs(config, solver_catalog.descriptor("structural-mechanics", "1.0.0"), model, solution)["stress"]
    resources = ResourceStore()
    try:
        result = resources.resolve(resources.ingest(field))
        values = result.members["stress"]["value"]
        bases = result.members["stressBasis"]["value"]
        expected_local = np.diag([1000 / 91, 300 / 91, 0.])
        expected_world = rotation @ expected_local @ rotation.T
        for value, basis in zip(values, bases):
            local = np.array([[value[0], value[3], value[5]], [value[3], value[1], value[4]], [value[5], value[4], value[2]]])
            np.testing.assert_allclose(basis, rotation, atol=1e-14)
            np.testing.assert_allclose(basis @ local @ basis.T, expected_world, atol=1e-13)
    finally:
        resources.close()


def test_static_link_chain_transfers_force_and_eccentric_moment_to_fixed_support():
    points = np.array([[0., 0., 0.], [2., .3, -.4], [2.5, 1., .7]])
    model = StructuralModel(np.arange(3), points, [], np.arange(18), np.arange(6), np.zeros((3, 6)))
    # 선언 순서가 뒤집혀도 말단부터 지지점까지 전달해야 한다.
    model.links = [(1, 2, np.arange(6)), (0, 1, np.arange(6))]
    model.force[2] = [1., 3., -2., .4, -.7, 1.1]
    K, M, _, prepared = prepare_matrices(model)
    result = static_analysis(model, prepared, K, M)
    force, moment = model.force[2, :3], model.force[2, 3:]
    expected = -np.r_[force, moment + np.cross(points[2] - points[0], force)]
    np.testing.assert_allclose(result.reaction[0], expected, atol=1e-13)
    np.testing.assert_array_equal(result.reaction[1:], 0.)
    # 실제 지지점에서의 가상 강체 운동에 대해 외력 일과 반력 일이 상쇄된다.
    translation, spin = np.array([.1, -.2, .3]), np.array([.2, .1, -.3])
    applied_work = force @ (translation + np.cross(spin, points[2])) + moment @ spin
    np.testing.assert_allclose(result.reaction[0] @ np.r_[translation, spin] + applied_work, 0., atol=1e-14)


def test_gravity_of_eccentric_linked_mass_is_visible_at_the_prescribed_support():
    points = np.array([[0., 0., 0.], [2., .5, 0.]])
    model = StructuralModel(np.arange(2), points, [], np.arange(12), np.arange(6), np.zeros((2, 6)))
    model.links = [(0, 1, np.arange(6))]
    model.masses = [(1, 3., np.eye(3))]
    model.gravity = np.array([0., 0., -10.])
    K, M, C, prepared = prepare_matrices(model)
    result = initialize_acceleration(model, initial_solution(model), prepared, K, M, C, np.asarray(M @ np.tile(np.r_[model.gravity, np.zeros(3)], 2)), True)
    expected = np.array([0., 0., 30., 15., -60., 0.])
    np.testing.assert_allclose(result.reaction[0], expected, atol=1e-13)
    np.testing.assert_array_equal(result.reaction[1], 0.)


def test_revolute_rotor_support_balances_exact_centripetal_force_and_moment():
    points = np.array([[0., 0., 0.], [.4, 0., 0.], [.4, 1., .2]])
    model = StructuralModel(np.arange(3), points, [], np.arange(18), np.arange(6), np.zeros((3, 6)))
    model.links = [(0, 1, np.array([0, 1, 2, 4, 5])), (1, 2, np.arange(6))]
    model.masses = [(1, 1., .1 * np.eye(3)), (2, 2., np.zeros((3, 3)))]
    K, M, C, prepared = prepare_matrices(model)
    initial = initial_solution(model)
    initial.orientations[0] = rotation_exp([.3, -.6, .2])
    axis = initial.orientations[0][:, 0]
    initial.displacement[1, 3] = .7
    initial.velocity[1, 3:] = 3. * axis
    result = initialize_acceleration(model, initial, prepared, K, M, C, np.zeros(18), True)
    for _ in range(5):
        result = transient_step(model, result, prepared, K, M, C, np.zeros(18), .02, 0., 1e-10, 15, True)
    positions = points + result.displacement[:, :3]
    radial = positions[2] - positions[1]
    force = -2. * 3.**2 * radial
    expected = np.r_[force, np.cross(positions[2] - positions[0], force)]
    np.testing.assert_allclose(result.reaction[0], expected, rtol=1e-10, atol=1e-10)
    np.testing.assert_array_equal(result.reaction[1:], 0.)
