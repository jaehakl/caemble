"""Batched tet4 integration for the explicitly linear thermal-solid path."""

import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import connected_components

from app.methods.finite_element.scalar import ScalarElements
from app.methods.assembly.chunks import element_chunk, sum_sparse_chunks
from .prepared import PreparedStructuralOperators
from ..solid_elements import SolidElements


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


def thermal_batches(model, cells, chunk_size=32768):
    """Rebuild gradients and constitutive workspaces for one reference chunk."""
    for start in range(0, len(cells), chunk_size):
        stop = min(start + chunk_size, len(cells))
        geometry = ScalarElements.prepare(model.points, cells[start:stop])
        B = thermal_gradient_matrix(geometry.gradients)
        if isinstance(model.elements, SolidElements):
            elasticity = np.asarray([material["C"] for material in model.elements.materials])[model.elements.material_indices[start:stop]]
        else:
            elasticity = np.asarray([element.material["C"] for element in model.elements[start:stop]])
        dofs = (6 * cells[start:stop, :, None] + np.arange(3)).reshape(-1, 12)
        yield slice(start, stop), dofs, B, elasticity, geometry.volumes


def thermal_gradient_matrix(gradients):
    B = np.zeros((len(gradients), 6, 12))
    for node in range(4):
        x, y, z = gradients[:, node].T
        offset = 3 * node
        B[:, 0, offset], B[:, 1, offset + 1], B[:, 2, offset + 2] = x, y, z
        B[:, 3, offset], B[:, 3, offset + 1] = y, x
        B[:, 4, offset + 1], B[:, 4, offset + 2] = z, y
        B[:, 5, offset], B[:, 5, offset + 2] = z, x
    return B


def prepare_thermal_matrices(model):
    cells = model.elements.cells if isinstance(model.elements, SolidElements) else np.asarray([element.nodes for element in model.elements])
    validate_thermal_supports(model, cells)
    shape = (model.size, model.size)
    model.thermal_force = np.zeros(model.size)
    body_force = np.zeros(model.size)
    constrained = model.linear_solver == "cg-amg" and not model.links
    free = lookup = prescribed_values = prescribed_force = None
    assembly_shape = shape
    block_size = 1
    if constrained:
        free = np.asarray(model.active)[~np.isin(model.active, model.fixed)]
        lookup = np.full(model.size, -1, dtype=np.int32 if len(free) < 2**31 else np.int64)
        lookup[free] = np.arange(len(free))
        assembly_shape = (len(free), len(free))
        if len(free) and len(free) % 3 == 0:
            groups = free.reshape(-1, 3)
            if np.all(groups[:, 0] % 6 == 0) and np.all(groups == groups[:, :1] + np.arange(3)):
                block_size = 3
        if any(model.prescribed.values()):
            prescribed_values = np.zeros(model.size)
            for dof, value in model.prescribed.items():
                prescribed_values[dof] = value
            prescribed_force = np.zeros(model.size)

    def stiffness_chunks():
        for selected, dofs, B, elasticity, volumes in thermal_batches(model, cells):
            K = np.einsum("eai,eab,ebj->eij", B, elasticity, B, optimize=True) * volumes[:, None, None]
            stress = model.thermal_strain[selected].mean(axis=1)[:, None] * elasticity[:, :, :3].sum(axis=-1)
            force = np.einsum("eai,ea,e->ei", B, stress, volumes)
            np.add.at(model.thermal_force, dofs.ravel(), force.ravel())
            if prescribed_values is not None:
                fixed_force = np.einsum("eij,ej->ei", K, prescribed_values[dofs])
                np.add.at(prescribed_force, dofs.ravel(), fixed_force.ravel())
            if np.any(model.gravity):
                density = (np.asarray([material["density"] for material in model.elements.materials])[model.elements.material_indices[selected]]
                           if isinstance(model.elements, SolidElements) else np.asarray([element.material["density"] for element in model.elements[selected]]))
                weights = np.repeat(density * volumes / 4, 4)
                np.add.at(body_force.reshape(-1, 6)[:, :3], cells[selected].ravel(), weights[:, None] * model.gravity)
            yield element_chunk(K, lookup[dofs] if constrained else dofs, assembly_shape, block_size=block_size)

    stiffness = sum_sparse_chunks(stiffness_chunks(), assembly_shape)
    # Static solids need only the integrated body force, not a mass operator.
    batch = {"cells": cells, "body_force": body_force}
    if constrained:
        batch.update(free_stiffness=stiffness, free_dofs=free, prescribed_force=prescribed_force)
    return PreparedStructuralOperators(None if constrained else stiffness, sparse.coo_matrix(shape), sparse.coo_matrix(shape), [],
                                       thermal_batch=batch)


def thermal_batch_response(model, displacement, prepared):
    force = np.zeros(model.size)
    # Retain cell averages only. The affine thermal stress is reconstructed
    # from the original four corner temperatures for point/section outputs.
    stress = np.empty((len(model.elements), 1, 6))
    energy = 0.
    quadrature = np.full((4, 4), (5 - np.sqrt(5)) / 20) + np.eye(4) / np.sqrt(5)
    for selected, dofs, B, elasticity, volumes in thermal_batches(model, prepared.thermal_batch["cells"]):
        strain = np.einsum("eai,ei->ea", B, np.asarray(displacement).ravel()[dofs])
        elastic = np.broadcast_to(strain[:, None, :], (len(strain), 4, 6)).copy()
        elastic[:, :, :3] -= (model.thermal_strain[selected] @ quadrature.T)[:, :, None]
        quadrature_stress = np.einsum("eab,egb->ega", elasticity, elastic)
        stress[selected, 0] = quadrature_stress.mean(axis=1)
        element_force = np.einsum("eai,ea,e->ei", B, stress[selected, 0], volumes)
        np.add.at(force, dofs.ravel(), element_force.ravel())
        energy += .125 * np.einsum("ega,ega,e->", elastic, quadrature_stress, volumes)
    return force, prepared.stiffness, [], stress, float(energy)


def thermal_polar_frames(model, displacement):
    """The existing volume-weighted polar projection, batched for large tet meshes."""
    cells = model.elements.cells if isinstance(model.elements, SolidElements) else np.asarray([element.nodes for element in model.elements])
    projected = np.zeros((len(model.points), 3, 3))
    for start in range(0, len(cells), 32768):
        selected = cells[start:start + 32768]
        geometry = ScalarElements.prepare(model.points, selected)
        deformation = np.eye(3) + np.einsum("eia,eib->eab", displacement[selected, :3], geometry.gradients)
        left, stretches, right = np.linalg.svd(deformation)
        rotations = left @ right
        if np.any(np.linalg.det(rotations) <= 0) or np.any(stretches <= 1e-10):
            raise ValueError("tet4 current configuration is inverted or degenerate")
        for node in range(4):
            np.add.at(projected, selected[:, node], geometry.volumes[:, None, None] * rotations)
    for start in range(0, len(projected), 32768):
        left, _, right = np.linalg.svd(projected[start:start + 32768])
        left[:, :, 2] *= np.linalg.det(left @ right)[:, None]
        projected[start:start + 32768] = left @ right
    return projected
