"""Topology and consistency checks independent of the Stokes iteration."""

from itertools import combinations, permutations

import numpy as np
import pytest

from app.methods.finite_volume.tetrahedral import _gradient_extensions, cell_operators, create_fv_mesh, upwind_convection


def tetrahedral_box(shape=(3, 3, 3), size=(1., 1., 1.), *, irregular=True):
    shape, size = np.asarray(shape), np.asarray(size)
    coordinates = np.asarray(list(np.ndindex(tuple(shape + 1))), dtype=float) / shape
    if irregular:
        amplitude = np.prod(np.sin(np.pi * coordinates), axis=1)
        coordinates += amplitude[:, None] * np.array([.17, -.13, .11]) / shape
    points = coordinates * size
    indices = np.arange(len(points)).reshape(tuple(shape + 1))
    cells = []
    for origin in np.ndindex(tuple(shape)):
        for ordering in permutations(range(3)):
            current = np.array(origin)
            cell = [indices[tuple(current)]]
            for axis in ordering:
                current[axis] += 1
                cell.append(indices[tuple(current)])
            cells.append(cell)
    faces = {}
    for cell in cells:
        for face in combinations(cell, 3):
            key = tuple(sorted(face))
            faces[key] = faces.get(key, 0) + 1
    boundary = np.asarray([face for face, count in faces.items() if count == 1])
    return create_fv_mesh(points, np.asarray(cells), boundary)


def test_tetrahedral_face_geometry_and_conservation():
    mesh = tetrahedral_box()
    assert mesh.maximum_nonorthogonality > 20
    assert mesh.maximum_skewness > .01
    assert np.isclose(mesh.cell_volumes.sum(), 1.)
    assert np.all(mesh.cell_volumes > 0)
    assert np.allclose(mesh.divergence @ mesh.area_vectors, 0, atol=1e-15)
    internal = mesh.neighbour >= 0
    flux = np.random.default_rng(28).normal(size=len(mesh.faces))
    flux[~internal] = 0
    assert abs(np.sum(mesh.divergence @ flux)) < 1e-13
    assert np.array_equal(np.sort(mesh.boundary_face_map), np.flatnonzero(~internal))


def test_gradient_extension_adds_second_ring_without_reweighting_original_neighbours():
    mesh = tetrahedral_box((3, 3, 3))
    rows, columns, delta, weights = _gradient_extensions(mesh)
    internal = mesh.neighbour >= 0
    immediate = {tuple(sorted(pair)) for pair in zip(mesh.owner[internal], mesh.neighbour[internal], strict=True)}
    assert len(rows) > len(mesh.cells)
    assert all(tuple(sorted(pair)) not in immediate for pair in zip(rows, columns, strict=True))
    assert np.all(rows != columns) and np.all(weights > 0)
    np.testing.assert_array_equal(mesh.gradient_weights, 1.)
    np.testing.assert_allclose(delta, mesh.cell_centers[columns]-mesh.cell_centers[rows], atol=0.)


@pytest.mark.parametrize("gradient", ([0., 0., 0.], [1.7, -.4, 2.1]))
def test_irregular_tetrahedral_operators_reproduce_constant_and_linear_fields(gradient):
    mesh = tetrahedral_box()
    gradient = np.asarray(gradient)
    values = .73 + mesh.cell_centers @ gradient
    boundary = .73 + mesh.face_centers @ gradient
    operators = cell_operators(mesh, mesh.neighbour < 0)
    restored = (operators.gradient @ values + operators.gradient_boundary @ boundary).reshape(-1, 3)
    gauss = (operators.gauss_gradient @ values + operators.gauss_gradient_boundary @ boundary).reshape(-1, 3)
    faces = operators.face_value @ values + operators.face_value_boundary @ boundary
    flux = operators.normal_gradient @ values + operators.normal_gradient_boundary @ boundary
    assert np.allclose(restored, gradient, atol=2e-13)
    assert np.allclose(gauss, gradient, atol=2e-13)
    assert np.allclose(faces, boundary, atol=2e-14)
    assert np.allclose(flux, mesh.area_vectors @ gradient, atol=2e-14)
    assert np.allclose(mesh.divergence @ flux, 0, atol=2e-14)


def test_pressure_face_operator_does_not_hide_checkerboard_pressure():
    mesh = tetrahedral_box()
    operators = cell_operators(mesh, np.zeros(len(mesh.faces), dtype=bool))
    laplacian = (-mesh.divergence @ operators.normal_gradient).toarray()
    singular = np.linalg.svd(laplacian, compute_uv=False)
    assert singular[-1] < singular[0] * 1e-12
    assert singular[-2] > singular[0] * 1e-4
    checkerboard = np.where(np.arange(len(mesh.cells)) % 2, 1., -1.)
    assert np.linalg.norm(operators.normal_gradient @ checkerboard) > 1


def test_cell_and_vertex_order_do_not_change_physical_face_fluxes():
    original = tetrahedral_box()
    permutation = np.random.default_rng(91).permutation(len(original.cells))
    changed = create_fv_mesh(original.points, original.cells[permutation][:, [3, 1, 0, 2]],
                             original.faces[original.boundary_face_map][::-1, ::-1])
    gradient = np.array([.3, -.7, .4])
    for mesh in (original, changed):
        operators = cell_operators(mesh, mesh.neighbour < 0)
        values = mesh.cell_centers @ gradient
        boundary = mesh.face_centers @ gradient
        flux = operators.normal_gradient @ values + operators.normal_gradient_boundary @ boundary
        assert np.allclose(flux, mesh.area_vectors @ gradient, atol=1e-14)
        assert np.allclose(mesh.divergence @ flux, 0, atol=1e-14)


def test_disconnected_fluid_volume_is_explicitly_rejected():
    mesh = tetrahedral_box((1, 1, 1))
    points = np.vstack([mesh.points, mesh.points + [3, 0, 0]])
    cells = np.vstack([mesh.cells, mesh.cells + len(mesh.points)])
    boundary = mesh.faces[mesh.boundary_face_map]
    boundary = np.vstack([boundary, boundary + len(mesh.points)])
    with pytest.raises(ValueError, match="one connected fluid region"):
        create_fv_mesh(points, cells, boundary)


def test_mixed_nonzero_neumann_data_reproduces_linear_pressure_and_flux():
    mesh = tetrahedral_box()
    exterior = mesh.neighbour < 0
    dirichlet = exterior & np.isclose(mesh.face_centers[:, 0], 1.)
    operators = cell_operators(mesh, dirichlet)
    gradient = np.array([.3, -.7, .9])
    normal = mesh.area_vectors / np.linalg.norm(mesh.area_vectors, axis=1)[:, None]
    boundary = np.where(dirichlet, .8 + mesh.face_centers @ gradient, normal @ gradient)
    boundary[~exterior] = 0
    values = .8 + mesh.cell_centers @ gradient
    restored = (operators.gauss_gradient @ values + operators.gauss_gradient_boundary @ boundary).reshape(-1, 3)
    flux = operators.normal_gradient @ values + operators.normal_gradient_boundary @ boundary
    assert np.allclose(restored, gradient, atol=3e-14)
    assert np.allclose(flux, mesh.area_vectors @ gradient, atol=3e-15)


def test_upwind_internal_momentum_transport_is_conservative_and_changes_donor():
    mesh = tetrahedral_box()
    operators = cell_operators(mesh, mesh.neighbour < 0)
    internal = mesh.neighbour >= 0
    values = np.random.default_rng(6).normal(size=(len(mesh.cells), 3))
    flux = np.linspace(-.5, .5, len(mesh.faces))
    flux[~internal] = 0
    matrix, boundary = upwind_convection(mesh, flux, operators)
    donor = np.where(flux[internal] >= 0, mesh.owner[internal], mesh.neighbour[internal])
    face_transport = np.zeros((len(mesh.faces), 3))
    face_transport[internal] = flux[internal, None] * values[donor]
    assert np.allclose(matrix @ values, mesh.divergence @ face_transport, atol=2e-15)
    assert np.allclose((matrix @ values).sum(axis=0), 0, atol=1e-14)
    assert boundary.nnz == 0
