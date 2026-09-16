"""P1 tetrahedral diffusion, load integration and constrained sparse solves."""

from dataclasses import dataclass

import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import connected_components
from scipy.sparse.linalg import splu


@dataclass(frozen=True)
class ScalarElements:
    cells: np.ndarray
    gradients: np.ndarray
    volumes: np.ndarray
    node_count: int

    @classmethod
    def prepare(cls, points, cells):
        cells = np.asarray(cells, dtype=np.int64)
        coordinates = np.asarray(points)[cells]
        jacobian = coordinates[:, 1:] - coordinates[:, :1]
        determinant = np.linalg.det(jacobian)
        if np.any(determinant <= 0):
            raise ValueError("scalar FEM requires positive tetrahedral volumes")
        gradients = np.empty((len(cells), 4, 3))
        gradients[:, 1:] = np.linalg.inv(jacobian).transpose(0, 2, 1)
        gradients[:, 0] = -gradients[:, 1:].sum(axis=1)
        return cls(cells, gradients, determinant / 6, len(points))

    def diffusion(self, tensors):
        tensors = np.broadcast_to(np.asarray(tensors), (len(self.cells), 3, 3))
        elements = np.einsum("eia,eab,ejb,e->eij", self.gradients, tensors, self.gradients, self.volumes)
        rows = np.repeat(self.cells, 4, axis=1).ravel()
        columns = np.tile(self.cells, (1, 4)).ravel()
        return sparse.coo_matrix((elements.ravel(), (rows, columns)), shape=(self.node_count, self.node_count)).tocsr()

    def volume_load(self, cell_values):
        return np.bincount(self.cells.ravel(), weights=np.repeat(np.asarray(cell_values) * self.volumes / 4, 4), minlength=self.node_count)

    def gradient(self, nodal_values):
        return np.einsum("ei,eia->ea", np.asarray(nodal_values)[self.cells], self.gradients)


def surface_integrals(points, faces, coefficient=0.0, flux=0.0):
    """Consistent triangle mass and constant inward flux load (SI)."""
    faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    vertices = np.asarray(points)[faces]
    areas = np.linalg.norm(np.cross(vertices[:, 1] - vertices[:, 0], vertices[:, 2] - vertices[:, 0]), axis=1) / 2
    entries = coefficient * areas[:, None, None] * (np.ones((3, 3)) + np.eye(3)) / 12
    matrix = sparse.coo_matrix((entries.ravel(), (np.repeat(faces, 3, axis=1).ravel(), np.tile(faces, (1, 3)).ravel())), shape=(len(points), len(points))).tocsr()
    load = np.bincount(faces.ravel(), weights=np.repeat(flux * areas / 3, 3), minlength=len(points))
    return matrix, load, areas


def solve_scalar(matrix, load, fixed, *, tolerance, cancellation=None, anchored_nodes=()):
    """Keep the original equations for reactions and check every connected part."""
    if cancellation is not None:
        cancellation.raise_if_cancelled()
    n = len(load)
    fixed_nodes = np.asarray(sorted(fixed), dtype=int)
    count, labels = connected_components(matrix, directed=False)
    # The caller identifies positive boundary exchange explicitly. Inferring it
    # from matrix row sums loses weak exchange beside very large conductance.
    anchored = set(labels[fixed_nodes]) | set(labels[np.asarray(anchored_nodes, dtype=int)])
    if len(anchored) != count:
        raise ValueError("each connected diffusion domain requires a potential/temperature constraint or positive Robin exchange")
    free = np.setdiff1d(np.arange(n), fixed_nodes)
    values = np.zeros(n)
    values[fixed_nodes] = [fixed[node] for node in fixed_nodes]
    if len(free):
        reduced = matrix[free][:, free].tocsc()
        rhs = load[free] - matrix[free][:, fixed_nodes] @ values[fixed_nodes]
        scale = 1 / np.sqrt(reduced.diagonal())
        scaled = sparse.diags(scale) @ reduced @ sparse.diags(scale)
        factor = splu(scaled.tocsc())
        values[free] = scale * factor.solve(scale * rhs)
        # One iterative correction also improves balances in very thin layers.
        values[free] += scale * factor.solve(scale * (rhs - reduced @ values[free]))
        residual = np.linalg.norm(reduced @ values[free] - rhs) / max(np.linalg.norm(rhs), np.linalg.norm(reduced @ values[free]), np.finfo(float).tiny)
    else:
        residual = 0.0
    if not np.all(np.isfinite(values)) or residual > tolerance:
        raise ValueError(f"scalar FEM did not converge: relative residual {residual:g}")
    if cancellation is not None:
        cancellation.raise_if_cancelled()
    return values, np.asarray(matrix @ values - load), float(residual)
