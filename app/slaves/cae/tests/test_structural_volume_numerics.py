"""Generated-volume mechanics that must not depend on authored mesh IDs."""

import numpy as np
import pytest
from scipy import sparse

from app.kernel.resources import ResourceStore
import app.solvers.structural_mechanics.analysis as analysis_module
from app.solvers.structural_mechanics.analysis import (
    initial_solution,
    initialize_acceleration,
    kinematic_rates,
    modal_analysis,
    transient_step,
)
from app.solvers.structural_mechanics.constraints import constraint_transform, contact_response
from app.solvers.structural_mechanics.coupling import predict_motion
from app.solvers.structural_mechanics.continuum import (
    physical_angular_velocities,
    physical_orientation_matrices,
    physical_rotation_vectors,
    tet4_corotational_response,
)
from app.solvers.structural_mechanics.materials import isotropic_elasticity
from app.solvers.structural_mechanics.meshing import brick_mesh
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.outputs import (
    _region_resultants,
    _section_resultants,
    build_outputs,
    configure_history,
    history_members,
    physical_support_reactions,
)
from app.solvers.structural_mechanics.state import append_history
from app.solvers.structural_mechanics.rotations import rotation_exp
from app.solvers.structural_mechanics.formulation import prepare_matrices


TETRAHEDRON = np.array([
    [0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.],
])


def test_corotated_tet_is_objective_and_has_energy_consistent_force_and_tangent():
    rng = np.random.default_rng(812)
    coefficients = rng.normal(size=(6, 6))
    elasticity = 2.1e4 * (coefficients.T @ coefficients + np.eye(6))
    displacement = .08 * rng.normal(size=(4, 3))
    direction = rng.normal(size=(4, 3))
    force, tangent, energy, stress = tet4_corotational_response(TETRAHEDRON, displacement, elasticity)
    step = 1e-6
    plus = tet4_corotational_response(TETRAHEDRON, displacement + step * direction, elasticity)
    minus = tet4_corotational_response(TETRAHEDRON, displacement - step * direction, elasticity)
    np.testing.assert_allclose(force @ direction.ravel(), (plus[2] - minus[2]) / (2 * step), rtol=2e-8)
    np.testing.assert_allclose(tangent @ direction.ravel(), (plus[0] - minus[0]) / (2 * step), rtol=2e-7)
    np.testing.assert_allclose(tangent, tangent.T, rtol=2e-8, atol=2e-6)
    assert stress.shape == (4, 6)

    rotation = rotation_exp(np.array([1.1, -.4, .7]))
    moved = (TETRAHEDRON + displacement) @ rotation.T + [.3, -.2, .5] - TETRAHEDRON
    rotated_force, _, rotated_energy, _ = tet4_corotational_response(TETRAHEDRON, moved, elasticity)
    np.testing.assert_allclose(rotated_energy, energy, rtol=2e-14)
    np.testing.assert_allclose(rotated_force.reshape(4, 3), force.reshape(4, 3) @ rotation.T, rtol=3e-10, atol=2e-9)


def test_generated_tet_rotation_is_polar_and_linear_spectra_use_displacement_curl():
    auxiliary = np.array([[2., 2., 2.]])
    points = np.vstack((TETRAHEDRON, auxiliary))
    material = {"model": "mechanics.isotropic-elastic@1", "C": isotropic_elasticity(1., .2), "density": 1.}
    model = StructuralModel(
        np.arange(5), points, [Element("tet4", np.arange(4), material)],
        np.arange(12), np.empty(0, dtype=int), np.zeros((5, 6)), physical_node_count=4,
    )
    rotation = rotation_exp(np.array([.7, -.3, .2]))
    displacement = np.zeros((5, 6))
    displacement[:4, :3] = TETRAHEDRON @ rotation.T - TETRAHEDRON
    orientations = np.tile(np.eye(3), (5, 1, 1))
    actual = physical_rotation_vectors(model, displacement, orientations)
    np.testing.assert_allclose(
        np.array([rotation_exp(value) for value in actual[:4]]),
        np.broadcast_to(rotation, (4, 3, 3)), atol=2e-14,
    )
    np.testing.assert_array_equal(actual[4], 0.)

    infinitesimal = np.zeros_like(displacement)
    infinitesimal[:4, :3] = np.cross([.2, -.1, .3], TETRAHEDRON)
    np.testing.assert_allclose(
        physical_rotation_vectors(model, infinitesimal, orientations, linear=True)[:4],
        np.tile([.2, -.1, .3], (4, 1)), atol=2e-16,
    )


def test_generated_tet_motion_uses_polar_frames_and_exact_spatial_spin():
    points = np.vstack((TETRAHEDRON, [[2., 2., 2.]]))
    material = {"model": "mechanics.isotropic-elastic@1", "C": isotropic_elasticity(1., .2), "density": 1.}
    model = StructuralModel(
        np.arange(5), points, [Element("tet4", np.arange(4), material)],
        np.arange(12), np.empty(0, dtype=int), np.zeros((5, 6)), physical_node_count=4,
    )
    rotation = rotation_exp(np.array([.7, -.3, .2]))
    displacement = np.zeros((5, 6))
    displacement[:4, :3] = TETRAHEDRON @ rotation.T - TETRAHEDRON
    orientations = np.tile(np.eye(3), (5, 1, 1))
    orientations[4] = rotation_exp(np.array([0., 0., .4]))
    frames = physical_orientation_matrices(model, displacement, orientations)
    np.testing.assert_allclose(frames[:4], np.broadcast_to(rotation, (4, 3, 3)), atol=2e-14)
    np.testing.assert_allclose(frames[4], orientations[4])

    angular = np.array([.4, -.2, .6])
    current = TETRAHEDRON @ rotation.T
    velocity = np.zeros((5, 6))
    velocity[:4, :3] = np.cross(angular, current)
    velocity[4, 3:] = [1., 2., 3.]
    actual = physical_angular_velocities(model, displacement, velocity)
    np.testing.assert_allclose(actual[:4], np.tile(angular, (4, 1)), atol=3e-15)
    np.testing.assert_array_equal(actual[4], [1., 2., 3.])

    deformation = np.array([[1.08, .12, -.03], [.04, .93, .08], [0., -.02, 1.04]])
    deformation_rate = np.array([[.2, -.1, .04], [.03, -.08, .07], [-.02, .06, .1]])
    displacement[:4, :3] = TETRAHEDRON @ deformation.T - TETRAHEDRON
    velocity[:4, :3] = TETRAHEDRON @ deformation_rate.T
    step = 1e-7
    plus = displacement.copy()
    minus = displacement.copy()
    plus[:4, :3] += step * velocity[:4, :3]
    minus[:4, :3] -= step * velocity[:4, :3]
    rotation_now = physical_orientation_matrices(model, displacement, orientations)[0]
    rotation_rate = (
        physical_orientation_matrices(model, plus, orientations)[0]
        - physical_orientation_matrices(model, minus, orientations)[0]
    ) / (2 * step)
    spin = rotation_rate @ rotation_now.T
    expected = [spin[2, 1], spin[0, 2], spin[1, 0]]
    np.testing.assert_allclose(
        physical_angular_velocities(model, displacement, velocity)[:4],
        np.tile(expected, (4, 1)), rtol=2e-8, atol=2e-10,
    )


def test_large_modal_and_buckling_systems_use_positive_sparse_spectra(monkeypatch):
    count = 30
    size = count * 6
    model = StructuralModel(
        np.arange(count), np.zeros((count, 3)), [], np.arange(size),
        np.empty(0, dtype=int), np.zeros((count, 6)),
    )
    stiffness = sparse.diags(np.arange(1, size + 1, dtype=float))
    mass = sparse.eye(size)
    modes = modal_analysis(model, stiffness, mass, 3)
    np.testing.assert_allclose(modes["frequencies"], np.sqrt([1., 2., 3.]) / (2 * np.pi), rtol=2e-11)
    flattened = modes["modes"].reshape(3, -1)
    np.testing.assert_allclose(flattened @ mass @ flattened.T, np.eye(3), atol=2e-13)

    geometric = -sparse.diags(1 / np.arange(1, size + 1, dtype=float))
    monkeypatch.setattr(analysis_module, "geometric_matrix", lambda *_: geometric)
    buckling = analysis_module.buckling_analysis(
        model, sparse.eye(size), np.zeros((count, 6)), [], 3,
    )
    np.testing.assert_allclose(buckling["factors"], [1., 2., 3.], rtol=2e-11)


def test_sparse_free_volume_modes_skip_six_rigid_body_modes():
    points, bricks = brick_mesh([0., 0., 0.], [1., 1., 1.], [3, 3, 3])
    split = np.array([
        [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6],
        [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6],
    ])
    cells = bricks[:, split].reshape(-1, 4)
    material = {"model": "mechanics.isotropic-elastic@1", "C": isotropic_elasticity(1000., .2), "density": 2.}
    model = StructuralModel(
        np.arange(len(points)), points, [Element("tet4", nodes, material) for nodes in cells],
        (6 * np.arange(len(points))[:, None] + np.arange(3)).ravel(),
        np.empty(0, dtype=int), np.zeros((len(points), 6)),
    )
    stiffness, mass, _, _ = prepare_matrices(model)
    result = modal_analysis(model, stiffness, mass, 2)
    assert np.all(np.isfinite(result["frequencies"])) and np.all(result["frequencies"] > 0)
    modes = result["modes"].reshape(2, -1)
    np.testing.assert_allclose(modes @ mass @ modes.T, np.eye(2), atol=2e-10)


def test_many_attachment_rows_keep_kinematic_jacobians_sparse(monkeypatch):
    count = 300
    angles = np.linspace(0., 2 * np.pi, count, endpoint=False)
    points = np.vstack((np.column_stack((np.zeros(count), np.cos(angles), np.sin(angles))), np.zeros(3)))
    master = count
    model = StructuralModel(
        np.arange(count + 1), points, [],
        np.r_[(6 * np.arange(count)[:, None] + np.arange(3)).ravel(), 6 * master + np.arange(6)],
        np.empty(0, dtype=int), np.zeros((count + 1, 6)), physical_node_count=count,
    )
    model.links = [(master, slave, np.arange(3)) for slave in range(count)]
    orientations = np.tile(np.eye(3), (count + 1, 1, 1))
    orientations[master] = rotation_exp([.3, -.2, .4])
    velocity = np.zeros((count + 1, 6))
    acceleration = np.zeros_like(velocity)
    velocity[master] = [.2, -.1, .3, .4, -.3, .2]
    acceleration[master] = [-.2, .1, .05, -.1, .2, .3]
    transform = constraint_transform(model, orientations)

    def reject_dense(*_args, **_kwargs):
        raise AssertionError("attachment Jacobian must not materialize a dense linked-row matrix")

    monkeypatch.setattr(sparse.csr_matrix, "toarray", reject_dense)
    zero = kinematic_rates(model, orientations, velocity, acceleration, transform=transform)
    assert sparse.isspmatrix_csr(zero[2]) and zero[2].nnz == zero[3].nnz == 0
    actual_v, actual_a, velocity_jacobian, acceleration_jacobian = kinematic_rates(
        model, orientations, velocity, acceleration, transform=transform,
        velocity_factor=7., acceleration_factor=13.,
    )
    assert sparse.isspmatrix_csr(velocity_jacobian) and sparse.isspmatrix_csr(acceleration_jacobian)
    assert velocity_jacobian.nnz < 40 * count and acceleration_jacobian.nnz < 50 * count
    arms = (orientations[master] @ (points[:count] - points[master]).T).T
    np.testing.assert_allclose(actual_v[:count, :3], velocity[master, :3] + np.cross(velocity[master, 3:], arms))
    np.testing.assert_allclose(
        actual_a[:count, :3],
        acceleration[master, :3] + np.cross(acceleration[master, 3:], arms)
        + np.cross(velocity[master, 3:], np.cross(velocity[master, 3:], arms)),
    )


def test_fixed_tet_attachment_advances_one_real_transient_step():
    points = np.vstack((TETRAHEDRON, TETRAHEDRON[:3].mean(axis=0)))
    material = {"model": "mechanics.isotropic-elastic@1", "C": isotropic_elasticity(1000., .2), "density": 1.}
    model = StructuralModel(
        np.arange(5), points, [Element("tet4", np.arange(4), material)],
        np.r_[(6 * np.arange(4)[:, None] + np.arange(3)).ravel(), 24 + np.arange(6)],
        24 + np.arange(6), np.zeros((5, 6)), physical_node_count=4,
    )
    model.links = [(4, node, np.arange(3)) for node in range(3)]
    stiffness, mass, damping, prepared = prepare_matrices(model)
    solution = initial_solution(model)
    solution = initialize_acceleration(
        model, solution, prepared, stiffness, mass, damping, np.zeros(model.size), True,
    )
    advanced = transient_step(
        model, solution, prepared, stiffness, mass, damping, np.zeros(model.size),
        .01, 0., 1e-10, 8, True,
    )
    assert advanced.time == pytest.approx(.01)
    np.testing.assert_allclose(advanced.displacement, 0., atol=1e-15)


def test_surface_contact_is_area_scaled_and_owns_a_shared_master_edge_once():
    master = np.array([[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]])
    slave = np.array([[.2, .2, -.1], [.8, .2, -.1], [.2, .8, -.1]])
    points = np.vstack((master, slave))
    contact = {
        "masterFaces": np.array([[0, 1, 2], [0, 2, 3]]),
        "slaveFaces": np.array([[4, 5, 6]]),
        "penalty": 1000.,
    }
    force, tangent, active = contact_response(points, np.zeros((7, 6)), [contact])
    nodal = force.reshape(-1, 6)[:, :3]
    np.testing.assert_allclose(nodal.sum(axis=0), 0., atol=3e-15)
    np.testing.assert_allclose(nodal[4:, 2].sum(), -18.)
    assert len(active) == 3
    np.testing.assert_allclose(sum(item["normalForce"] for item in active), 18.)
    uniform_slave_motion = np.zeros(42)
    uniform_slave_motion.reshape(-1, 6)[4:, 2] = 1.
    np.testing.assert_allclose((tangent @ uniform_slave_motion).reshape(-1, 6)[4:, 2].sum(), 180.)


def test_surface_contact_resultant_is_independent_of_slave_triangulation():
    master = np.array([[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]])
    master_faces = np.array([[0, 1, 2], [0, 2, 3]])
    results = []
    for divisions in (1, 3):
        axis = np.linspace(0., 1., divisions + 1)
        slave = np.array([[x, y, -.1] for y in axis for x in axis])
        faces = []
        for row in range(divisions):
            for column in range(divisions):
                lower = row * (divisions + 1) + column
                a, b = lower, lower + 1
                d, c = lower + divisions + 1, lower + divisions + 2
                faces.extend(([a, b, c], [a, c, d]))
        points = np.vstack((master, slave))
        contact = {"masterFaces": master_faces, "slaveFaces": np.asarray(faces) + 4, "penalty": 1000.}
        force, tangent, _ = contact_response(points, np.zeros((len(points), 6)), [contact])
        direction = np.zeros(len(points) * 6)
        direction.reshape(-1, 6)[4:, 2] = 1.
        results.append((force.reshape(-1, 6)[4:, 2].sum(), (tangent @ direction).reshape(-1, 6)[4:, 2].sum()))
    np.testing.assert_allclose(results, [[-100., 1000.], [-100., 1000.]], atol=2e-12)


def test_physical_field_excludes_reference_nodes_and_section_integrates_tet_traction():
    points = np.vstack((TETRAHEDRON, [[2., 2., 2.]]))
    material = {"model": "mechanics.isotropic-elastic@1", "C": isotropic_elasticity(1., .2), "density": 1.}
    model = StructuralModel(
        np.arange(5), points, [Element("tet4", np.arange(4), material)],
        np.arange(12), np.empty(0, dtype=int), np.zeros((5, 6)),
        identity="generated-volume", physical_node_count=4,
    )
    model.cell_regions["experiment.geometry.body"] = np.array([0])
    model.result_requests["section"] = {
        "regions": ["experiment.geometry.body"], "origin": [.2, 0., 0.],
        "normal": [1., 0., 0.], "referencePoint": [.2, 0., 0.],
    }
    solution = initial_solution(model)
    solution.stresses[0] = np.tile([10., 0., 0., 0., 0., 0.], (4, 1))
    section = _section_resultants(model, solution, model.result_requests["section"])
    np.testing.assert_allclose(section["force"], [[3.2, 0., 0.]])
    np.testing.assert_allclose(section["moment"], [[0., 12.8 / 15, -12.8 / 15]])

    descriptor = {"methods": {"outputs": [{
        "methodId": "fea.stress-field", "artifactType": "caemble.mechanics/stress-field@1",
        "data": {"quantityKind": "Pressure", "unit": "Pa"},
    }]}}
    artifact = build_outputs(
        {"outputs": [{"methodId": "fea.stress-field", "key": "stress"}]},
        descriptor, model, solution,
    )["stress"]
    assert artifact.domain.points.shape == (4, 3)
    np.testing.assert_array_equal(artifact.domain.cells["tet4"], [[0, 1, 2, 3]])
    np.testing.assert_allclose(artifact.values, [[10., 0., 0., 0., 0., 0.]])


def test_stress_field_geometry_target_builds_a_consistent_cell_submesh():
    points = np.vstack((TETRAHEDRON, TETRAHEDRON + [2., 0., 0.]))
    material = {"model": "mechanics.isotropic-elastic@1", "C": isotropic_elasticity(1., .2), "density": 1.}
    model = StructuralModel(
        np.arange(8), points,
        [Element("tet4", np.arange(4), material), Element("tet4", 4 + np.arange(4), material)],
        (6 * np.arange(8)[:, None] + np.arange(3)).ravel(), np.empty(0, dtype=int),
        np.zeros((8, 6)), identity="two-volumes", physical_node_count=8,
    )
    target = "experiment.geometry.second"
    model.cell_regions[target] = np.array([1])
    faces = np.array([
        [0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2],
        [4, 5, 6], [4, 7, 5], [4, 6, 7], [5, 7, 6],
    ])
    model.provenance = {
        "physicalNodeCount": 8, "boundaryFaces": faces,
        "cellRegions": np.array([0, 1]),
        "regionIds": np.array(["experiment:first", "experiment:second"]),
        "supportNodes": np.array([0, 4]),
        "loadPoints": np.empty((0, 3)), "loadVectors": np.empty((0, 3)),
        "quality": {"cellVolumes": np.array([1 / 6, 1 / 6]), "meanRatios": np.array([.8, .9])},
        "boundaryProvenance": {
            "offsets": np.arange(9), "sources": np.array(["experiment"] * 8),
            "rootIds": np.array(["first"] * 4 + ["second"] * 4),
            "sourceNodeIds": np.array(["first.box"] * 4 + ["second.box"] * 4),
            "surfaceIndices": np.tile(np.arange(4), 2),
        },
        "elementBlocks": [
            {"methodId": "fea.body", "target": ["experiment.geometry.first"], "rootId": "first", "cellType": "tet4", "elementIds": np.array([0])},
            {"methodId": "fea.body", "target": [target], "rootId": "second", "cellType": "tet4", "elementIds": np.array([1])},
        ],
    }
    model.result_requests["stress"] = {"regions": [target]}
    solution = initial_solution(model)
    solution.stresses = [np.tile([1., 0., 0., 0., 0., 0.], (4, 1)), np.tile([2., 0., 0., 0., 0., 0.], (4, 1))]
    descriptor = {"methods": {"outputs": [{
        "methodId": "fea.stress-field", "artifactType": "caemble.mechanics/stress-field@1",
        "data": {"quantityKind": "Pressure", "unit": "Pa"},
    }]}}
    artifact = build_outputs(
        {"outputs": [{"methodId": "fea.stress-field", "key": "stress", "target": [target]}]},
        descriptor, model, solution,
    )["stress"]
    np.testing.assert_allclose(artifact.domain.points, TETRAHEDRON + [2., 0., 0.])
    np.testing.assert_array_equal(artifact.domain.cells["tet4"], [[0, 1, 2, 3]])
    np.testing.assert_allclose(artifact.values, [[2., 0., 0., 0., 0., 0.]])
    assert artifact.domain.identity != model.identity
    metadata = artifact.domain.metadata
    np.testing.assert_array_equal(metadata["cellRegions"], [0])
    np.testing.assert_array_equal(metadata["regionIds"], ["experiment:second"])
    np.testing.assert_allclose(metadata["quality"]["cellVolumes"], [1 / 6])
    np.testing.assert_allclose(metadata["quality"]["meanRatios"], [.9])
    np.testing.assert_array_equal(metadata["boundaryFaces"], faces[4:] - 4)
    np.testing.assert_array_equal(metadata["boundaryProvenance"]["offsets"], np.arange(5))
    np.testing.assert_array_equal(metadata["boundaryProvenance"]["rootIds"], ["second"] * 4)
    np.testing.assert_array_equal(metadata["supportNodes"], [0])
    assert metadata["provenance"]["physicalNodeCount"] == 4
    np.testing.assert_array_equal(metadata["provenance"]["elementBlocks"][0]["elementIds"], [0])


def test_attachment_support_wrench_is_conserved_on_physical_field_and_history():
    reference = np.array([1 / 3, 1 / 3, 0.])
    points = np.vstack((TETRAHEDRON, reference))
    material = {"model": "mechanics.isotropic-elastic@1", "C": isotropic_elasticity(1., .2), "density": 1.}
    model = StructuralModel(
        np.arange(5), points, [Element("tet4", np.arange(4), material)],
        np.arange(12), 24 + np.arange(6), np.zeros((5, 6)),
        identity="attached-support", physical_node_count=4,
    )
    target = "experiment.surface.support"
    model.boundary_regions[target] = {
        "faces": np.array([[0, 1, 2]]), "nodes": np.array([0, 1, 2]),
        "weights": np.full(3, 1 / 3), "area": .5, "rootId": "body",
        "referencePoint": reference,
    }
    model.provenance["auxiliaryNodes"] = {target: 4}
    solution = initial_solution(model)
    solution.reaction[4] = [3., -5., 7., 11., -13., 17.]
    mapped = physical_support_reactions(model, solution.reaction, solution.displacement)
    np.testing.assert_allclose(mapped[:4, :3].sum(axis=0), solution.reaction[4, :3])
    np.testing.assert_allclose(
        np.cross(points[:4] - reference, mapped[:4, :3]).sum(axis=0),
        solution.reaction[4, 3:],
    )

    request = {"regions": [target], "referencePoint": reference}
    result = _region_resultants(model, solution, request)
    np.testing.assert_allclose(result["force"], [solution.reaction[4, :3]])
    np.testing.assert_allclose(result["moment"], [solution.reaction[4, 3:]])

    model.result_requests["history"] = {"regions": [target]}
    configure_history(model, [{"methodId": "fea.history", "key": "history", "parameters": {"scope": "final"}}])
    append_history(model, solution)
    history = history_members(model, solution, scope="final", regions=[target])
    np.testing.assert_allclose(history["reaction"], [[solution.reaction[4, :3]]])
    np.testing.assert_allclose(history["reactionMoment"], [[solution.reaction[4, 3:]]])

    descriptor = {"methods": {"outputs": [{"methodId": "fea.interface", "data": {}}]}}
    interface = build_outputs(
        {"outputs": [{"methodId": "fea.interface", "key": "interface"}]},
        descriptor, model, solution,
    )["interface"]
    motion = predict_motion(model, solution, {
        "dt": .01, "windowSize": .01, "duration": .01,
    })
    resources = ResourceStore()
    try:
        for value in (interface, motion):
            restored = resources.resolve(resources.ingest(value))
            np.testing.assert_array_equal(restored.metadata["regions"][target], [0, 1, 2])
            assert restored.metadata["regionReferences"] == {target: 4}
    finally:
        resources.close()
