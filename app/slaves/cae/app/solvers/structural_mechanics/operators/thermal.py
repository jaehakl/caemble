"""Batched tet4 integration for the explicitly linear thermal-solid path."""

import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import connected_components

from app.methods.finite_element.scalar import ScalarElements
from .prepared import PreparedStructuralOperators


def validate_thermal_supports(model, cells):
    """Each disconnected solid must have all six rigid motions constrained."""
    graph = sparse.coo_matrix((np.ones(3 * len(cells)),
        (np.repeat(cells[:, 0], 3), cells[:, 1:].ravel())), shape=(len(model.points), len(model.points))).tocsr()
    count, labels = connected_components(graph, directed=False)
    fixed = np.unique(np.r_[model.fixed, np.asarray(list(model.prescribed), dtype=int)])
    fixed = fixed[fixed % 6 < 3]
    for component in range(count):
        points = model.points[labels == component]
        selected = fixed[labels[fixed // 6] == component]
        if len(selected) < 6:
            raise ValueError("each thermal structural solid requires supports that remove all rigid motions")
        positions = (model.points[selected // 6] - points.mean(axis=0)) / np.max(np.ptp(points, axis=0))
        rows = np.zeros((len(selected), 6))
        axes = np.eye(3)[selected % 6]
        rows[:, :3] = axes
        rows[:, 3:] = np.cross(positions, axes)
        singular = np.linalg.svd(rows, compute_uv=False)
        if singular[-1] <= singular[0] * 1e-10:
            raise ValueError("each thermal structural solid requires supports that remove all rigid motions")


def prepare_thermal_matrices(model):
    cells = np.asarray([element.nodes for element in model.elements])
    validate_thermal_supports(model, cells)
    geometry = ScalarElements.prepare(model.points, cells)
    gradients, volumes = geometry.gradients, geometry.volumes
    elasticity = np.asarray([element.material["C"] for element in model.elements])
    density = np.asarray([element.material["density"] for element in model.elements])
    B = np.zeros((len(cells), 6, 12))
    for node in range(4):
        x, y, z = gradients[:, node].T
        offset = 3 * node
        B[:, 0, offset], B[:, 1, offset + 1], B[:, 2, offset + 2] = x, y, z
        B[:, 3, offset], B[:, 3, offset + 1] = y, x
        B[:, 4, offset + 1], B[:, 4, offset + 2] = z, y
        B[:, 5, offset], B[:, 5, offset + 2] = z, x
    K = np.einsum("eai,eab,ebj->eij", B, elasticity, B, optimize=True) * volumes[:, None, None]
    M = (density * volumes / 20)[:, None, None] * np.kron(np.ones((4, 4)) + np.eye(4), np.eye(3))
    dofs = (6 * cells[:, :, None] + np.arange(3)).reshape(-1, 12)
    rows, columns = np.repeat(dofs, 12, axis=1).ravel(), np.tile(dofs, (1, 12)).ravel()
    shape = (model.size, model.size)
    stiffness = sparse.csr_matrix((K.ravel(), (rows, columns)), shape=shape)
    mass = sparse.csr_matrix((M.ravel(), (rows, columns)), shape=shape)
    # Four positive degree-two quadrature points integrate affine temperature
    # stress and quadratic elastic energy exactly, matching continuum.py.
    quadrature = np.full((4, 4), (5 - np.sqrt(5)) / 20) + np.eye(4) / np.sqrt(5)
    eigenstrain = model.thermal_strain @ quadrature.T
    thermal_stress = eigenstrain[:, :, None] * elasticity[:, None, :, :3].sum(axis=-1)
    element_force = np.einsum("eai,ea,e->ei", B, thermal_stress.mean(axis=1), volumes)
    model.thermal_force = np.zeros(model.size)
    np.add.at(model.thermal_force, dofs.ravel(), element_force.ravel())
    data = {"dofs": dofs, "B": B, "C": elasticity, "volumes": volumes, "eigenstrain": eigenstrain}
    return PreparedStructuralOperators(stiffness, mass, sparse.csr_matrix(shape), [], thermal_batch=data)


def thermal_batch_response(model, displacement, prepared):
    data = prepared.thermal_batch
    values = np.asarray(displacement).ravel()[data["dofs"]]
    strain = np.einsum("eai,ei->ea", data["B"], values)
    elastic = np.broadcast_to(strain[:, None, :], (len(strain), 4, 6)).copy()
    elastic[:, :, :3] -= data["eigenstrain"][:, :, None]
    stress = np.einsum("eab,egb->ega", data["C"], elastic)
    element_force = np.einsum("eai,ea,e->ei", data["B"], stress.mean(axis=1), data["volumes"])
    force = np.zeros(model.size)
    np.add.at(force, data["dofs"].ravel(), element_force.ravel())
    energy = .125 * np.einsum("ega,ega,e->", elastic, stress, data["volumes"])
    return force, prepared.stiffness, [None] * len(model.elements), stress, float(energy)


def thermal_polar_frames(model, displacement):
    """The existing volume-weighted polar projection, batched for large tet meshes."""
    cells = np.asarray([element.nodes for element in model.elements])
    geometry = ScalarElements.prepare(model.points, cells)
    deformation = np.eye(3) + np.einsum("eia,eib->eab", displacement[cells, :3], geometry.gradients)
    left, stretches, right = np.linalg.svd(deformation)
    rotations = left @ right
    if np.any(np.linalg.det(rotations) <= 0) or np.any(stretches <= 1e-10):
        raise ValueError("tet4 current configuration is inverted or degenerate")
    projected = np.zeros((len(model.points), 3, 3))
    for node in range(4):
        np.add.at(projected, cells[:, node], geometry.volumes[:, None, None] * rotations)
    left, _, right = np.linalg.svd(projected)
    left[:, :, 2] *= np.linalg.det(left @ right)[:, None]
    return left @ right
