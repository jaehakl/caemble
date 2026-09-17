"""Exact integration and extrema of P1 fields over a clipped observation Box."""

from itertools import product

import numpy as np


def clipped_tetrahedron(vertices):
    """Return oriented-independent convex polygon faces inside the unit Box."""
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
            for first, second, a, b in zip(polygon, np.roll(polygon, -1, axis=0), distances, np.roll(distances, -1), strict=True):
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
            return []
        if intersections:
            cap = np.unique(np.asarray(intersections), axis=0)
            if len(cap) >= 3:
                plane = cap[:, [dimension for dimension in range(3) if dimension != axis]]
                offset = plane - plane.mean(axis=0)
                clipped.append(cap[np.argsort(np.arctan2(offset[:, 1], offset[:, 0]))])
        polygons = clipped
    return polygons


def scalar_box_statistics(points, cells, values, grid):
    """Material-volume mean and native linear-field extrema, not grid estimates."""
    coordinates = grid.local_points(np.asarray(points), "m") / np.asarray(grid.geometry["size"])
    total_volume = integral = 0.0
    minimum, maximum = np.inf, -np.inf
    cells = np.asarray(cells)
    boundary = []
    for start in range(0, len(cells), 65536):
        block = cells[start:start + 65536]
        vertices = coordinates[block]
        selected = np.flatnonzero(np.all(vertices.max(axis=1) > 0, axis=1) & np.all(vertices.min(axis=1) < 1, axis=1))
        inside = np.all((vertices[selected] >= 0) & (vertices[selected] <= 1), axis=(1, 2))
        contained = selected[inside]
        if len(contained):
            volumes = np.abs(np.linalg.det(vertices[contained, 1:] - vertices[contained, :1])) / 6
            nodal = np.asarray(values)[block[contained]]
            total_volume += volumes.sum()
            integral += volumes @ nodal.mean(axis=1)
            minimum, maximum = min(minimum, nodal.min()), max(maximum, nodal.max())
        boundary.append(selected[~inside] + start)
    for cell in cells[np.concatenate(boundary) if boundary else np.empty(0, dtype=int)]:
        vertices = coordinates[cell]
        nodal = np.asarray(values)[cell]
        polygons = clipped_tetrahedron(vertices)
        if not polygons:
            continue
        corners = np.concatenate(polygons)
        center = corners.mean(axis=0)
        gradient = np.linalg.solve(vertices[1:] - vertices[0], nodal[1:] - nodal[0])
        corner_values = nodal[0] + (corners - vertices[0]) @ gradient
        cell_volume = cell_integral = 0.0
        for polygon in polygons:
            for index in range(1, len(polygon) - 1):
                tetra = np.asarray([center, polygon[0], polygon[index], polygon[index + 1]])
                volume = abs(np.linalg.det(tetra[1:] - tetra[0])) / 6
                cell_volume += volume
                cell_integral += volume * (nodal[0] + (tetra.mean(axis=0) - vertices[0]) @ gradient)
        if cell_volume > 0:
            total_volume += cell_volume
            integral += cell_integral
            minimum, maximum = min(minimum, corner_values.min()), max(maximum, corner_values.max())
    if total_volume == 0:
        return 0., 0., 0.
    return integral / total_volume, float(minimum), float(maximum)
