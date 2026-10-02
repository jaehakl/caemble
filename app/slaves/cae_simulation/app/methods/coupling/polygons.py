"""Planar convex polygon measures and intersections in world coordinates."""

import numpy as np


def polygon_area_centroid(vertices):
    """Area and first area moment, evaluated relative to a nearby vertex."""
    vertices = np.asarray(vertices, dtype=float).reshape(-1, 3)
    if len(vertices) < 3:
        return 0., np.zeros(3)
    relative = vertices[1:] - vertices[0]
    areas = np.linalg.norm(np.cross(relative[:-1], relative[1:]), axis=1) / 2
    area = float(areas.sum())
    if area == 0:
        return 0., vertices[0].copy()
    centroid = vertices[0] + (areas[:, None] * (relative[:-1] + relative[1:])).sum(axis=0) / (3 * area)
    return area, centroid


def intersect_coplanar_triangles(first, second, normal):
    """Intersect two triangles on an already validated common plane.

    A local orthonormal frame avoids subtracting large world coordinates in the
    clipping predicates. The result has the first triangle's orientation.
    """
    first, second = np.asarray(first, dtype=float), np.asarray(second, dtype=float)
    normal = np.asarray(normal, dtype=float)
    normal = normal / np.linalg.norm(normal)
    origin = first[0]
    tangent = first[1] - origin
    tangent /= np.linalg.norm(tangent)
    frame = np.column_stack((tangent, np.cross(normal, tangent)))
    polygon = list((first - origin) @ frame)
    clipping = (second - origin) @ frame
    edge_a, edge_b = clipping[1] - clipping[0], clipping[2] - clipping[0]
    orientation = np.sign(edge_a[0] * edge_b[1] - edge_a[1] * edge_b[0])
    if orientation == 0:
        return np.empty((0, 3))
    for index in range(3):
        start, end = clipping[index], clipping[(index + 1) % 3]
        edge = end - start
        clipped = []
        for a, b in zip(polygon, polygon[1:] + polygon[:1]):
            da = orientation * (edge[0] * (a[1] - start[1]) - edge[1] * (a[0] - start[0]))
            db = orientation * (edge[0] * (b[1] - start[1]) - edge[1] * (b[0] - start[0]))
            if da >= 0:
                clipped.append(a)
            if (da >= 0) != (db >= 0):
                clipped.append(a + da / (da - db) * (b - a))
        polygon = clipped
    return np.asarray(polygon).reshape(-1, 2) @ frame.T + origin
