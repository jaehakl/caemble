"""P1 tetrahedral diffusion, load integration and constrained sparse solves."""

from dataclasses import dataclass

import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import connected_components
from app.methods.assembly.chunks import element_chunk, sum_sparse_chunks
from app.methods.linalg.direct import solve_sparse


TET4_QUADRATURE = np.full((4, 4), (5 - np.sqrt(5)) / 20) + np.eye(4) / np.sqrt(5)


@dataclass(frozen=True)
class ScalarElements:
    cells: np.ndarray
    gradients: np.ndarray
    volumes: np.ndarray
    node_count: int

    @classmethod
    def prepare(cls, points, cells):
        cells = np.asarray(cells, dtype=np.int64)
        gradients = np.empty((len(cells), 4, 3))
        volumes = np.empty(len(cells))
        for start in range(0, len(cells), 65536):
            selected = slice(start, start + 65536)
            coordinates = np.asarray(points)[cells[selected]]
            jacobian = coordinates[:, 1:] - coordinates[:, :1]
            determinant = np.linalg.det(jacobian)
            if np.any(determinant <= 0):
                raise ValueError("scalar FEM requires positive tetrahedral volumes")
            gradients[selected, 1:] = np.linalg.inv(jacobian).transpose(0, 2, 1)
            gradients[selected, 0] = -gradients[selected, 1:].sum(axis=1)
            volumes[selected] = determinant / 6
        return cls(cells, gradients, volumes, len(points))

    def diffusion(self, tensors):
        tensors = np.broadcast_to(np.asarray(tensors), (len(self.cells), 3, 3))
        def chunks():
            for start in range(0, len(self.cells), 65536):
                selected = slice(start, start + 65536)
                cells = self.cells[selected]
                entries = np.einsum("eia,eab,ejb,e->eij", self.gradients[selected], tensors[selected],
                                    self.gradients[selected], self.volumes[selected])
                yield element_chunk(entries, cells, (self.node_count, self.node_count))
        return sum_sparse_chunks(chunks(), (self.node_count, self.node_count))

    def capacity(self, cell_capacity):
        """Consistent P1 volume mass for a constant coefficient in each element."""
        coefficients = np.broadcast_to(cell_capacity, (len(self.cells),))
        def chunks():
            for start in range(0, len(self.cells), 65536):
                selected = slice(start, start + 65536)
                cells = self.cells[selected]
                entries = (coefficients[selected] * self.volumes[selected])[:, None, None] * (np.ones((4, 4)) + np.eye(4)) / 20
                yield element_chunk(entries, cells, (self.node_count, self.node_count))
        return sum_sparse_chunks(chunks(), (self.node_count, self.node_count))

    def volume_load(self, cell_values):
        return np.bincount(self.cells.ravel(), weights=np.repeat(np.asarray(cell_values) * self.volumes / 4, 4), minlength=self.node_count)

    def gradient(self, nodal_values):
        result = np.empty((len(self.cells), 3))
        for start in range(0, len(self.cells), 65536):
            selected = slice(start, start + 65536)
            values = np.asarray(nodal_values)[self.cells[selected]]
            result[selected] = np.einsum("ei,eia->ea", values[:, 1:] - values[:, :1], self.gradients[selected, 1:])
        return result


def surface_integrals(points, faces, coefficient=0.0, flux=0.0):
    """Consistent triangle mass and constant inward flux load (SI)."""
    faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    vertices = np.asarray(points)[faces]
    areas = np.linalg.norm(np.cross(vertices[:, 1] - vertices[:, 0], vertices[:, 2] - vertices[:, 0]), axis=1) / 2
    entries = coefficient * areas[:, None, None] * (np.ones((3, 3)) + np.eye(3)) / 12
    matrix = sparse.coo_matrix((entries.ravel(), (np.repeat(faces, 3, axis=1).ravel(), np.tile(faces, (1, 3)).ravel())), shape=(len(points), len(points))).tocsr()
    load = np.bincount(faces.ravel(), weights=np.repeat(flux * areas / 3, 3), minlength=len(points))
    return matrix, load, areas


def solve_scalar(matrix, load, fixed, *, tolerance, cancellation=None, anchored_nodes=(), backend="direct",
                 compensated=False):
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
    roundoff = np.zeros(n) if compensated else None
    values[fixed_nodes] = [fixed[node] for node in fixed_nodes]
    if len(free):
        reduced = matrix[free][:, free].tocsc()
        rhs = load[free] - matrix[free][:, fixed_nodes] @ values[fixed_nodes]
        solution = solve_sparse(reduced, rhs, positive_definite=True, ordering="MMD_AT_PLUS_A",
            backend=backend, tolerance=tolerance, cancellation=cancellation, compensated=compensated)
        if compensated:
            values[free], roundoff[free], residual = solution.values, solution.roundoff, solution.relative_residual
        else:
            values[free] = solution
            residual = np.linalg.norm(reduced @ values[free] - rhs) / max(np.linalg.norm(rhs), np.linalg.norm(reduced @ values[free]), np.finfo(float).tiny)
    else:
        residual = 0.0
    if not np.all(np.isfinite(values)) or residual > tolerance:
        raise ValueError(f"scalar FEM did not converge: relative residual {residual:g}")
    if cancellation is not None:
        cancellation.raise_if_cancelled()
    if compensated:
        from app.methods.linalg.compensated import physical_residual
        return values, -physical_residual(matrix, values, load, roundoff), float(residual), roundoff
    return values, np.asarray(matrix @ values - load), float(residual)
