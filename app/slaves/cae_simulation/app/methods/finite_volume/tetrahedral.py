"""Conservative face topology and linear-exact operators for tetrahedral cells."""

from dataclasses import dataclass, replace
from itertools import combinations

import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import connected_components


@dataclass(frozen=True)
class FaceMesh:
    """Physical tetrahedral triangles and the interfaces used for integration.

    ``faces`` and ``boundary_face_map`` retain physical mesh/provenance order.
    Owner/neighbour and all face operators instead use ``face_count`` interfaces.
    They differ only when a boundary is replaced by conservative connections.
    """
    points: np.ndarray
    cells: np.ndarray
    faces: np.ndarray
    owner: np.ndarray
    neighbour: np.ndarray
    face_centers: np.ndarray
    area_vectors: np.ndarray
    cell_centers: np.ndarray
    cell_volumes: np.ndarray
    boundary_face_map: np.ndarray
    interpolation_weights: np.ndarray
    skew_vectors: np.ndarray
    normal_coefficients: np.ndarray
    nonorthogonal_vectors: np.ndarray
    nonorthogonality: np.ndarray
    skewness: np.ndarray
    divergence: sparse.csr_matrix
    physical_owner: np.ndarray
    physical_neighbour: np.ndarray
    physical_face_centers: np.ndarray
    physical_area_vectors: np.ndarray
    cell_deltas: np.ndarray
    gradient_weights: np.ndarray
    interface_owner_faces: np.ndarray
    interface_neighbour_faces: np.ndarray
    neighbour_shifts: np.ndarray
    interface_offsets: np.ndarray
    interface_vertices: np.ndarray
    periodic_vectors: np.ndarray

    @property
    def face_count(self):
        return len(self.owner)

    @property
    def boundary_interface_indices(self):
        return np.flatnonzero((self.neighbour < 0) | (self.interface_neighbour_faces >= 0))

    @property
    def boundary_flux_map(self):
        boundary_index = np.full(len(self.faces), -1, dtype=int)
        boundary_index[self.boundary_face_map] = np.arange(len(self.boundary_face_map))
        rows, columns, signs = [], [], []
        for interface in self.boundary_interface_indices:
            rows.append(boundary_index[self.interface_owner_faces[interface]])
            columns.append(interface)
            signs.append(1.)
            other = self.interface_neighbour_faces[interface]
            if other >= 0:
                rows.append(boundary_index[other])
                columns.append(interface)
                signs.append(-1.)
        return sparse.coo_matrix((signs, (rows, columns)), shape=(len(self.boundary_face_map), self.face_count)).tocsr()

    @property
    def maximum_nonorthogonality(self):
        return float(self.nonorthogonality.max())

    @property
    def maximum_skewness(self):
        return float(self.skewness.max())


def create_fv_mesh(points, cells, boundary_faces):
    points, cells = np.asarray(points, dtype=float), np.asarray(cells, dtype=np.int64)
    boundary_faces = np.asarray(boundary_faces, dtype=np.int64)
    tetrahedra = points[cells]
    cell_centers = tetrahedra.mean(axis=1)
    cell_volumes = np.abs(np.linalg.det(tetrahedra[:, 1:] - tetrahedra[:, :1])) / 6
    if not len(cells) or np.any(~np.isfinite(cell_volumes) | (cell_volumes <= 0)):
        raise ValueError("finite-volume cells must have positive finite tetrahedral volume")
    face_indices, faces, owner, neighbour = {}, [], [], []
    for cell_index, cell in enumerate(cells):
        for vertices in combinations(cell, 3):
            key = tuple(sorted(int(vertex) for vertex in vertices))
            index = face_indices.get(key)
            if index is None:
                face_indices[key] = len(faces)
                faces.append(key)
                owner.append(cell_index)
                neighbour.append(-1)
            elif neighbour[index] == -1:
                neighbour[index] = cell_index
            else:
                raise ValueError(f"non-manifold finite-volume face {key} has more than two cells")
    faces = np.asarray(faces, dtype=np.int64)
    owner, neighbour = np.asarray(owner), np.asarray(neighbour)
    internal = neighbour >= 0
    face_points = points[faces]
    face_centers = face_points.mean(axis=1)
    area_vectors = np.cross(face_points[:, 1] - face_points[:, 0], face_points[:, 2] - face_points[:, 0]) / 2
    reverse = np.einsum("ij,ij->i", area_vectors, face_centers - cell_centers[owner]) < 0
    faces[reverse] = faces[reverse][:, [0, 2, 1]]
    area_vectors[reverse] *= -1
    delta = face_centers - cell_centers[owner]
    delta[internal] = cell_centers[neighbour[internal]] - cell_centers[owner[internal]]
    normal_distance = np.einsum("ij,ij->i", area_vectors, delta)
    area = np.linalg.norm(area_vectors, axis=1)
    if np.any(~np.isfinite(normal_distance) | (normal_distance <= 0)):
        face = int(np.flatnonzero(~np.isfinite(normal_distance) | (normal_distance <= 0))[0])
        raise ValueError(f"invalid finite-volume face {face} at {face_centers[face].tolist()}: nonpositive normal distance")
    fraction = np.einsum("ij,ij->i", area_vectors, face_centers - cell_centers[owner]) / normal_distance
    weights = 1 - fraction
    weights[~internal] = 1
    skew = face_centers - (cell_centers[owner] + fraction[:, None] * delta)
    normal_coefficients = area**2 / normal_distance
    nonorthogonal = area_vectors - normal_coefficients[:, None] * delta
    angles = np.degrees(np.arccos(np.clip(normal_distance / (area * np.linalg.norm(delta, axis=1)), -1, 1)))
    skewness = np.linalg.norm(skew, axis=1) / np.sqrt(area)
    boundary_map = np.asarray([face_indices[tuple(sorted(int(vertex) for vertex in face))] for face in boundary_faces])
    if len(np.unique(boundary_map)) != len(boundary_map) or set(boundary_map) != set(np.flatnonzero(~internal)):
        raise ValueError("finite-volume boundary provenance must cover each exterior face exactly once")
    indices = np.arange(len(faces))
    divergence = sparse.coo_matrix((
        np.r_[np.ones(len(faces)), -np.ones(np.count_nonzero(internal))],
        (np.r_[owner, neighbour[internal]], np.r_[indices, indices[internal]]),
    ), shape=(len(cells), len(faces))).tocsr()
    adjacency = sparse.coo_matrix((np.ones(np.count_nonzero(internal)), (owner[internal], neighbour[internal])), shape=(len(cells), len(cells)))
    count, labels = connected_components(adjacency, directed=False)
    if count != 1:
        sizes = np.bincount(labels).tolist()
        raise ValueError(f"incompressible flow requires one connected fluid region; found {count} with cell counts {sizes}")
    return FaceMesh(points, cells, faces, owner, neighbour, face_centers, area_vectors,
                    cell_centers, cell_volumes, boundary_map, weights, skew,
                    normal_coefficients, nonorthogonal, angles, skewness, divergence,
                    owner, neighbour, face_centers, area_vectors, delta, np.ones((len(faces), 2)),
                    np.arange(len(faces)), np.full(len(faces), -1, dtype=int), np.zeros((len(faces), 3)),
                    np.arange(len(faces) + 1) * 3, points[faces].reshape(-1, 3), np.empty((0, 3)))


def replace_fv_interfaces(mesh, *, owner, neighbour, face_centers, area_vectors,
                          owner_faces, neighbour_faces, neighbour_shifts, gradient_weights,
                          offsets, vertices, periodic_vectors):
    """Build conservative interface geometry with neighbour positions in the owner frame."""
    owner, neighbour = np.asarray(owner, dtype=int), np.asarray(neighbour, dtype=int)
    centers, vectors = np.asarray(face_centers), np.asarray(area_vectors)
    shifts, gradient_weights = np.asarray(neighbour_shifts), np.asarray(gradient_weights)
    internal = neighbour >= 0
    delta = centers - mesh.cell_centers[owner]
    delta[internal] = mesh.cell_centers[neighbour[internal]] + shifts[internal] - mesh.cell_centers[owner[internal]]
    areas = np.linalg.norm(vectors, axis=1)
    normal_distance = np.einsum("ij,ij->i", vectors, delta)
    invalid = ~np.isfinite(normal_distance) | (normal_distance <= 0) | (areas <= 0)
    if np.any(invalid):
        face = int(np.flatnonzero(invalid)[0])
        raise ValueError(f"invalid finite-volume interface {face}, cells {owner[face]}/{neighbour[face]}, "
                         f"position {centers[face].tolist()}, counterpart {(centers[face]-shifts[face]).tolist()}: nonpositive normal distance")
    fraction = np.einsum("ij,ij->i", vectors, centers - mesh.cell_centers[owner]) / normal_distance
    weights = 1 - fraction
    weights[~internal] = 1
    skew = centers - (mesh.cell_centers[owner] + fraction[:, None] * delta)
    coefficients = areas**2 / normal_distance
    nonorthogonal = vectors - coefficients[:, None] * delta
    angles = np.degrees(np.arccos(np.clip(normal_distance / (areas * np.linalg.norm(delta, axis=1)), -1, 1)))
    # A tiny overlap polygon must not inflate geometric skew merely by its area.
    physical_areas = np.linalg.norm(mesh.physical_area_vectors[np.asarray(owner_faces)], axis=1)
    skewness = np.linalg.norm(skew, axis=1) / np.sqrt(physical_areas)
    indices = np.arange(len(owner))
    divergence = sparse.coo_matrix((np.r_[np.ones(len(owner)), -np.ones(np.count_nonzero(internal))],
        (np.r_[owner, neighbour[internal]], np.r_[indices, indices[internal]])),
        shape=(len(mesh.cells), len(owner))).tocsr()
    return replace(mesh, owner=owner, neighbour=neighbour, face_centers=centers, area_vectors=vectors,
        cell_deltas=delta, interpolation_weights=weights, skew_vectors=skew, normal_coefficients=coefficients,
        nonorthogonal_vectors=nonorthogonal, nonorthogonality=angles, skewness=skewness, divergence=divergence,
        gradient_weights=gradient_weights, interface_owner_faces=np.asarray(owner_faces, dtype=int),
        interface_neighbour_faces=np.asarray(neighbour_faces, dtype=int), neighbour_shifts=shifts,
        interface_offsets=np.asarray(offsets, dtype=int), interface_vertices=np.asarray(vertices),
        periodic_vectors=np.asarray(periodic_vectors))


@dataclass(frozen=True)
class CellOperators:
    """Affine operators; boundary arrays use the same unique face order as the mesh."""

    gradient: sparse.csr_matrix
    gradient_boundary: sparse.csr_matrix
    face_value: sparse.csr_matrix
    face_value_boundary: sparse.csr_matrix
    normal_gradient: sparse.csr_matrix
    normal_gradient_boundary: sparse.csr_matrix
    gauss_gradient: sparse.csr_matrix
    gauss_gradient_boundary: sparse.csr_matrix


def _gradient_extensions(mesh):
    """Second-ring differences, including the accumulated periodic image shift.

    First-ring face weights remain unchanged. Products of successive face area
    fractions weight the added paths; summing equal paths makes splitting an
    overlap polygon leave the least-squares stencil exactly unchanged.
    """
    links = [{} for _ in mesh.cells]
    for face in np.flatnonzero(mesh.neighbour >= 0):
        owner, neighbour = int(mesh.owner[face]), int(mesh.neighbour[face])
        shift = tuple(mesh.neighbour_shifts[face])
        for cell, other, image, weight in ((owner, neighbour, shift, mesh.gradient_weights[face, 0]),
                (neighbour, owner, tuple(-value for value in shift), mesh.gradient_weights[face, 1])):
            key = (other, image)
            links[cell][key] = links[cell].get(key, 0.) + weight
    rows, columns, displacements, weights = [], [], [], []
    for cell, first_ring in enumerate(links):
        paths = {}
        for (neighbour, first_shift), first_weight in first_ring.items():
            for (other, second_shift), second_weight in links[neighbour].items():
                shift = tuple(first + second for first, second in zip(first_shift, second_shift, strict=True))
                key = (other, shift)
                if key in first_ring or (other == cell and shift == (0., 0., 0.)):
                    continue
                paths[key] = paths.get(key, 0.) + first_weight * second_weight
        for (other, shift), weight in paths.items():
            rows.append(cell)
            columns.append(other)
            displacements.append(mesh.cell_centers[other] + shift - mesh.cell_centers[cell])
            weights.append(weight)
    return (np.asarray(rows, dtype=int), np.asarray(columns, dtype=int),
            np.asarray(displacements).reshape(-1, 3), np.asarray(weights))


def cell_operators(mesh, dirichlet):
    """Two-ring weighted least squares, skew interpolation and full normal gradients.

    Boundary arrays contain values at Dirichlet faces and outward normal
    derivatives at the remaining exterior faces. Nonorthogonal terms remain part of the sparse linear
    operator, so solving the operator also converges its correction terms.
    """
    owner, neighbour = mesh.owner, mesh.neighbour
    internal = neighbour >= 0
    boundary = ~internal
    dirichlet = np.asarray(dirichlet, dtype=bool) & boundary
    count, face_count = len(mesh.cells), mesh.face_count
    delta = mesh.cell_deltas
    weighted_delta = delta / np.einsum("ij,ij->i", delta, delta)[:, None]
    moment = np.zeros((count, 3, 3))
    difference_faces = internal | dirichlet
    products = delta[:, :, None] * weighted_delta[:, None, :]
    np.add.at(moment, owner[difference_faces], products[difference_faces] * mesh.gradient_weights[difference_faces, 0, None, None])
    np.add.at(moment, neighbour[internal], products[internal] * mesh.gradient_weights[internal, 1, None, None])
    extra_rows, extra_columns, extra_delta, extra_weights = _gradient_extensions(mesh)
    extra_weighted_delta = extra_delta * (extra_weights / np.einsum("ij,ij->i", extra_delta, extra_delta))[:, None]
    np.add.at(moment, extra_rows, extra_delta[:, :, None] * extra_weighted_delta[:, None, :])
    normals = mesh.area_vectors / np.linalg.norm(mesh.area_vectors, axis=1)[:, None]
    neumann = boundary & ~dirichlet
    np.add.at(moment, owner[neumann], normals[neumann, :, None] * normals[neumann, None, :])
    eigenvalues = np.linalg.eigvalsh(moment)
    invalid = eigenvalues[:, 0] <= eigenvalues[:, -1] * 1e-12
    if np.any(invalid):
        cell = int(np.flatnonzero(invalid)[0])
        raise ValueError(f"rank-deficient finite-volume gradient stencil at cell {cell}, {mesh.cell_centers[cell].tolist()}")
    inverse = np.linalg.inv(moment)
    gradient_rows, gradient_columns, gradient_values = [], [], []
    boundary_rows, boundary_columns, boundary_values = [], [], []
    for face in np.flatnonzero(neumann):
        cell = owner[face]
        coefficient = inverse[cell] @ normals[face]
        for axis in range(3):
            boundary_rows.append(3 * cell + axis)
            boundary_columns.append(face)
            boundary_values.append(coefficient[axis])
    for face in np.flatnonzero(difference_faces):
        cell = owner[face]
        coefficient = inverse[cell] @ weighted_delta[face] * mesh.gradient_weights[face, 0]
        for axis in range(3):
            gradient_rows.append(3 * cell + axis)
            gradient_columns.append(cell)
            gradient_values.append(-coefficient[axis])
            if internal[face]:
                gradient_rows.append(3 * cell + axis)
                gradient_columns.append(neighbour[face])
                gradient_values.append(coefficient[axis])
            else:
                boundary_rows.append(3 * cell + axis)
                boundary_columns.append(face)
                boundary_values.append(coefficient[axis])
        if internal[face]:
            other = neighbour[face]
            coefficient = inverse[other] @ weighted_delta[face] * mesh.gradient_weights[face, 1]
            for axis in range(3):
                gradient_rows.extend([3 * other + axis, 3 * other + axis])
                gradient_columns.extend([other, cell])
                gradient_values.extend([coefficient[axis], -coefficient[axis]])
    gradient = sparse.coo_matrix((gradient_values, (gradient_rows, gradient_columns)), shape=(3 * count, count)).tocsr()
    gradient_boundary = sparse.coo_matrix((boundary_values, (boundary_rows, boundary_columns)), shape=(3 * count, face_count)).tocsr()
    extra_coefficients = np.einsum("nij,nj->ni", inverse[extra_rows], extra_weighted_delta)
    extra_gradient_rows = (3 * extra_rows[:, None] + np.arange(3)).ravel()
    gradient += sparse.coo_matrix((np.r_[extra_coefficients.ravel(), -extra_coefficients.ravel()],
        (np.r_[extra_gradient_rows, extra_gradient_rows], np.repeat(np.r_[extra_columns, extra_rows], 3))),
        shape=(3 * count, count)).tocsr()
    ids = np.arange(face_count)
    weights = mesh.interpolation_weights
    value_base = sparse.coo_matrix((np.r_[weights, 1 - weights[internal]],
        (np.r_[ids, ids[internal]], np.r_[owner, neighbour[internal]])), shape=(face_count, count)).tolil()
    value_base[dirichlet] = 0
    boundary_distance = np.einsum("ij,ij->i", normals, delta)
    value_boundary_base = sparse.diags(dirichlet.astype(float) + neumann * boundary_distance).tocsr()
    value_vectors = mesh.skew_vectors.copy()
    # At a zero-gradient boundary extrapolate in its tangent plane only.
    value_vectors[neumann] = delta[neumann] - normals[neumann] * np.einsum("ij,ij->i", normals[neumann], delta[neumann])[:, None]
    value_vectors[dirichlet] = 0
    correction_rows, correction_columns, value_data, normal_data = [], [], [], []
    for face in range(face_count):
        for cell, weight in ((owner[face], weights[face]), (neighbour[face], 1 - weights[face])):
            if cell < 0:
                continue
            for axis in range(3):
                correction_rows.append(face)
                correction_columns.append(3 * cell + axis)
                value_data.append(weight * value_vectors[face, axis])
                normal_data.append(weight * mesh.nonorthogonal_vectors[face, axis] if difference_faces[face] else 0)
    value_correction = sparse.coo_matrix((value_data, (correction_rows, correction_columns)), shape=(face_count, 3 * count)).tocsr()
    normal_correction = sparse.coo_matrix((normal_data, (correction_rows, correction_columns)), shape=(face_count, 3 * count)).tocsr()
    coefficients = mesh.normal_coefficients * difference_faces
    normal_base = sparse.coo_matrix((np.r_[-coefficients, coefficients[internal]],
        (np.r_[ids, ids[internal]], np.r_[owner, neighbour[internal]])), shape=(face_count, count)).tocsr()
    normal_boundary_base = sparse.diags(coefficients * dirichlet + neumann * np.linalg.norm(mesh.area_vectors, axis=1)).tocsr()
    face_value = value_base.tocsr() + value_correction @ gradient
    face_value_boundary = value_boundary_base + value_correction @ gradient_boundary
    normal_gradient = normal_base + normal_correction @ gradient
    normal_gradient_boundary = normal_boundary_base + normal_correction @ gradient_boundary
    gauss_rows, gauss_columns, gauss_values = [], [], []
    for face in range(face_count):
        for cell, sign in ((owner[face], 1), (neighbour[face], -1)):
            if cell < 0:
                continue
            for axis in range(3):
                gauss_rows.append(3 * cell + axis)
                gauss_columns.append(face)
                gauss_values.append(sign * mesh.area_vectors[face, axis] / mesh.cell_volumes[cell])
    gauss = sparse.coo_matrix((gauss_values, (gauss_rows, gauss_columns)), shape=(3 * count, face_count)).tocsr()
    return CellOperators(gradient, gradient_boundary, face_value, face_value_boundary,
                         normal_gradient, normal_gradient_boundary,
                         gauss @ face_value, gauss @ face_value_boundary)


def upwind_convection(mesh, face_volume_flux, operators):
    """One transported value per face, shared with opposite signs by its cells.

    Internal faces use their upstream cell. Boundary faces use their prescribed
    trace or the existing zero-normal-gradient opening trace, for either sign.
    Returned matrices give integrated convection and its boundary contribution.
    """
    flux = np.asarray(face_volume_flux)
    internal = mesh.neighbour >= 0
    ids = np.flatnonzero(internal)
    donor = np.where(flux[ids] >= 0, mesh.owner[ids], mesh.neighbour[ids])
    interpolation = sparse.coo_matrix((np.ones(len(ids)), (ids, donor)),
                                      shape=(mesh.face_count, len(mesh.cells))).tocsr()
    exterior = sparse.diags((~internal).astype(float))
    interpolation += exterior @ operators.face_value
    transport = mesh.divergence @ sparse.diags(flux)
    return (transport @ interpolation).tocsr(), (transport @ exterior @ operators.face_value_boundary).tocsr()
