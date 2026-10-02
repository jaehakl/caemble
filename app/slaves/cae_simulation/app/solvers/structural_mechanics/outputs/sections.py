"""Reference-plane sections shared by structural observation methods."""

import numpy as np

from ..continuum import integration_points


def _tet_plane_triangles(reference, displacement, origin, normal):
    """Current triangles of a material tet's intersection with a reference plane."""
    distances = (reference - origin) @ normal
    scale = max(np.max(np.linalg.norm(reference - reference.mean(axis=0), axis=1)), 1.)
    tolerance = 64 * np.finfo(float).eps * scale
    positive, negative = distances > tolerance, distances < -tolerance
    on_plane = np.abs(distances) <= tolerance
    barycentric = [np.eye(4)[index] for index in np.flatnonzero(on_plane)]
    if np.any(positive) and np.any(negative):
        for first in range(4):
            for second in range(first + 1, 4):
                if distances[first] * distances[second] < -tolerance**2:
                    fraction = distances[first] / (distances[first] - distances[second])
                    value = np.zeros(4)
                    value[first], value[second] = 1 - fraction, fraction
                    barycentric.append(value)
    elif np.count_nonzero(on_plane) < 3 or not np.any(negative):
        # A plane coincident with a shared face belongs to its negative side.
        return []
    unique = []
    for value in barycentric:
        if not any(np.linalg.norm(value - previous) <= 1e-12 for previous in unique):
            unique.append(value)
    if len(unique) < 3:
        return []
    barycentric = np.asarray(unique)
    plane_points = barycentric @ reference
    center = plane_points.mean(axis=0)
    first = plane_points[np.argmax(np.linalg.norm(plane_points - center, axis=1))] - center
    first /= np.linalg.norm(first)
    second = np.cross(normal, first)
    angles = np.arctan2((plane_points - center) @ second, (plane_points - center) @ first)
    barycentric = barycentric[np.argsort(angles)]
    current_nodes = reference + displacement
    current_points = barycentric @ current_nodes
    gradients = integration_points("tet4", reference)[0][3]
    deformation = current_nodes.T @ gradients
    current_normal = np.linalg.solve(deformation.T, normal)
    current_normal /= np.linalg.norm(current_normal)
    triangles = []
    for index in range(1, len(current_points) - 1):
        triangle = current_points[[0, index, index + 1]]
        if np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0]) @ current_normal < 0:
            triangle = triangle[[0, 2, 1]]
        triangles.append(triangle)
    return triangles
