"""Exact overlap volumes between tetrahedral cells and a rotated Box Grid."""

from dataclasses import dataclass
from itertools import product

import numpy as np
from scipy import sparse

from app.kernel.api.units import convert_ucum_value
from app.methods.fields.box_grid import BoxGrid


def _unit_box_intersection_volume(vertices):
    """Clip a convex tetrahedron, retaining the polygon closing each cut."""
    if np.all((vertices >= 0) & (vertices <= 1)):
        return abs(np.linalg.det(vertices[1:] - vertices[0])) / 6
    polygons = [vertices[list(face)] for face in ((0, 2, 1), (0, 1, 3), (0, 3, 2), (1, 2, 3))]
    for axis, bound in product(range(3), (0., 1.)):
        clipped, intersections = [], []
        sign = 1. if bound == 0 else -1.
        for polygon in polygons:
            distances = sign * (polygon[:, axis] - bound)
            if np.all(distances >= 0):
                clipped.append(polygon)
                continue
            if np.all(distances < 0):
                continue
            points = []
            for first, second, a, b in zip(polygon, np.roll(polygon, -1, axis=0),
                                            distances, np.roll(distances, -1), strict=True):
                if a >= 0:
                    points.append(first)
                if (a >= 0) != (b >= 0):
                    crossing = first + a / (a - b) * (second - first)
                    crossing[axis] = bound
                    points.append(crossing)
                    intersections.append(crossing)
            if len(points) >= 3:
                clipped.append(np.asarray(points))
        if not clipped:
            return 0.
        if intersections:
            cap = np.unique(np.asarray(intersections), axis=0)
            if len(cap) >= 3:
                plane = cap[:, [dimension for dimension in range(3) if dimension != axis]]
                offset = plane - plane.mean(axis=0)
                clipped.append(cap[np.argsort(np.arctan2(offset[:, 1], offset[:, 0]))])
        polygons = clipped
    # The centroid is inside this convex intersection. Each polygon fan and
    # the centroid enclose tetrahedra, independently of input face winding.
    center = np.concatenate(polygons).mean(axis=0)
    volume = 0.
    for polygon in polygons:
        normals = np.cross(polygon[1:-1] - polygon[0], polygon[2:] - polygon[0])
        volume += np.abs(normals @ (polygon[0] - center)).sum() / 6
    return volume


@dataclass(frozen=True)
class TetrahedralBoxOverlap:
    """Sparse SI volumes; pressure/velocity average only over occupied fluid."""

    volumes: sparse.csr_matrix
    fluid_volumes: np.ndarray
    box_cell_volume: float

    @classmethod
    def prepare(cls, points, cells, grid: BoxGrid, cancellation=None):
        """Use metre-valued mesh coordinates; the observation Box has its own unit."""
        spacing = np.asarray(grid.geometry["size"], dtype=float) / grid.shape
        local = grid.local_points(np.asarray(points), "m") / spacing
        box_volume = float(np.prod(spacing) * convert_ucum_value(1, grid.geometry["lengthUnit"], "m") ** 3)
        shape = np.asarray(grid.shape)
        rows, columns, volumes = [], [], []
        for cell_index, cell in enumerate(cells):
            if cancellation is not None and cell_index % 32 == 0:
                cancellation.raise_if_cancelled()
            vertices = local[cell]
            minimum, maximum = vertices.min(axis=0), vertices.max(axis=0)
            if np.any(maximum <= 0) or np.any(minimum >= shape):
                continue
            lower = np.floor(np.clip(minimum, 0, shape)).astype(int)
            upper = np.ceil(np.clip(maximum, 0, shape)).astype(int)
            for candidate, index in enumerate(product(*(range(lo, hi) for lo, hi in zip(lower, upper, strict=True)))):
                if cancellation is not None and candidate % 256 == 0:
                    cancellation.raise_if_cancelled()
                volume = _unit_box_intersection_volume(vertices - index) * box_volume
                if volume > 0:
                    rows.append(np.ravel_multi_index(index, grid.shape))
                    columns.append(cell_index)
                    volumes.append(volume)
        weights = sparse.coo_matrix((volumes, (rows, columns)),
                                    shape=(int(np.prod(shape)), len(cells))).tocsr()
        occupied = np.asarray(weights.sum(axis=1)).reshape(grid.shape)
        return cls(weights, occupied, box_volume)

    def average(self, values):
        """Keep trailing component/sample axes and return zero in empty cells."""
        values = np.asarray(values)
        integrated = self.volumes @ values.reshape(len(values), -1)
        occupied = self.fluid_volumes.reshape(-1, 1)
        averaged = np.divide(integrated, occupied, out=np.zeros_like(integrated), where=occupied > 0)
        return averaged.reshape((*self.fluid_volumes.shape, *values.shape[1:]))
