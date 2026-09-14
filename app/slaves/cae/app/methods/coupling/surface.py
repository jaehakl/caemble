"""Exact P1 boundary integration on independently triangulated coplanar patches."""

import numpy as np
from scipy import sparse
from scipy.spatial import cKDTree


def _cross2(first, second):
    return first[..., 0] * second[..., 1] - first[..., 1] * second[..., 0]


def _intersection(first, second, tolerance):
    polygon = list(first)
    if _cross2(second[1] - second[0], second[2] - second[0]) < 0:
        second = second[::-1]
    for start, end in zip(second, np.roll(second, -1, axis=0), strict=True):
        clipped = []
        if not polygon:
            break
        previous = polygon[-1]
        previous_distance = _cross2(end - start, previous - start)
        for current in polygon:
            distance = _cross2(end - start, current - start)
            inside, previous_inside = distance >= -tolerance, previous_distance >= -tolerance
            if inside != previous_inside:
                denominator = previous_distance - distance
                if abs(denominator) > np.finfo(float).eps:
                    clipped.append(previous + previous_distance / denominator * (current - previous))
            if inside:
                clipped.append(current)
            previous, previous_distance = current, distance
        polygon = []
        for point in clipped:
            if not polygon or np.linalg.norm(point - polygon[-1]) > tolerance:
                polygon.append(point)
        if len(polygon) > 1 and np.linalg.norm(polygon[0] - polygon[-1]) <= tolerance:
            polygon.pop()
    return polygon


def _planar_intersections(source_points, source_faces, target_points, target_faces):
    """Yield physical overlap triangles and coordinates, then check full coverage.

    Sources are P1 triangles; targets may be triangles or convex quadrilaterals.
    Both public operators consume the complete iterator before returning a result.
    """
    source_points, target_points = np.asarray(source_points, float), np.asarray(target_points, float)
    source_faces, target_faces = np.asarray(source_faces, int), np.asarray(target_faces, int)
    if not len(source_faces) or not len(target_faces):
        raise ValueError("surface coupling requires nonempty planar patches")
    source_triangles, target_triangles = source_points[source_faces], target_points[target_faces]
    target_cross = np.cross(target_triangles[:, 1] - target_triangles[:, 0], target_triangles[:, 2] - target_triangles[:, 0])
    source_cross = np.cross(source_triangles[:, 1] - source_triangles[:, 0], source_triangles[:, 2] - source_triangles[:, 0])
    if np.any(np.linalg.norm(target_cross, axis=1) == 0) or np.any(np.linalg.norm(source_cross, axis=1) == 0):
        raise ValueError("surface coupling contains a degenerate triangle")
    normal = target_cross[0] / np.linalg.norm(target_cross[0])
    source_normal = source_cross[0] / np.linalg.norm(source_cross[0])
    all_points = np.concatenate((source_triangles.reshape(-1, 3), target_triangles.reshape(-1, 3)))
    span = np.linalg.norm(np.ptp(all_points, axis=0))
    tolerance = 1e-10 + 128 * np.finfo(float).eps * max(float(np.max(np.abs(all_points))), span) / span
    origin = target_triangles[0, 0]
    if (np.max(np.abs((all_points - origin) @ normal)) > tolerance * span
            or np.any(target_cross @ normal <= 0) or np.any(source_cross @ source_normal <= 0)):
        raise ValueError("surface coupling requires coplanar, consistently oriented patches")
    tangent = target_triangles[0, 1] - origin
    tangent /= np.linalg.norm(tangent)
    basis = np.column_stack((tangent, np.cross(normal, tangent)))
    source = (source_triangles - origin) @ basis / span
    target = (target_triangles - origin) @ basis / span
    source_areas = np.abs(_cross2(source[:, 1] - source[:, 0], source[:, 2] - source[:, 0])) / 2
    target_areas = np.abs(np.sum(_cross2(target, np.roll(target, -1, axis=1)), axis=1)) / 2
    source_covered, target_covered = np.zeros(len(source)), np.zeros(len(target))
    centers = source.mean(axis=1)
    radii = np.linalg.norm(source - centers[:, None], axis=2).max(axis=1)
    tree = cKDTree(centers)
    lower, upper = source.min(axis=1), source.max(axis=1)
    for target_index, target_polygon in enumerate(target):
        center = target_polygon.mean(axis=0)
        radius = np.linalg.norm(target_polygon - center, axis=1).max()
        candidates = tree.query_ball_point(center, radius + radii.max() + tolerance)
        for source_index in candidates:
            if np.any(np.minimum(upper[source_index], target_polygon.max(axis=0))
                      < np.maximum(lower[source_index], target_polygon.min(axis=0)) - tolerance):
                continue
            polygon = _intersection(source[source_index], target_polygon, tolerance)
            for index in range(1, len(polygon) - 1):
                subtriangle = np.asarray([polygon[0], polygon[index], polygon[index + 1]])
                area = abs(_cross2(subtriangle[1] - subtriangle[0], subtriangle[2] - subtriangle[0])) / 2
                if area <= tolerance**2:
                    continue
                source_covered[source_index] += area
                target_covered[target_index] += area
                yield source_index, target_index, source[source_index], target_polygon, subtriangle, area * span**2, normal
    if (not np.allclose(source_covered, source_areas, rtol=1e-7, atol=tolerance**2)
            or not np.allclose(target_covered, target_areas, rtol=1e-7, atol=tolerance**2)):
        raise ValueError("surface coupling requires complete coincident patches without gaps or duplicate coverage")


def planar_surface_operator(source_points, source_faces, target_points, target_faces):
    """Return S[a,3*s+j] = integral Na * Ns * target_outward_normal[j] dA.

    This P1-to-P1 operator produces target FEM nodal integrals. The complete
    physical patches must coincide; no projection across gaps is performed.
    """
    source_faces, target_faces = np.asarray(source_faces, int), np.asarray(target_faces, int)
    rows, columns, values = [], [], []
    for si, ti, source, target, triangle, area, normal in _planar_intersections(
        source_points, source_faces, target_points, target_faces,
    ):
        local_target = np.linalg.solve((target[1:] - target[0]).T, (triangle - target[0]).T).T
        Na = np.column_stack((1 - local_target.sum(axis=1), local_target))
        local_source = np.linalg.solve((source[1:] - source[0]).T, (triangle - source[0]).T).T
        Ns = np.column_stack((1 - local_source.sum(axis=1), local_source))
        local = Na.T @ (area / 12 * (np.ones((3, 3)) + np.eye(3))) @ Ns
        block = (local[:, :, None] * normal).reshape(3, 9)
        rows.extend(np.repeat(target_faces[ti], 9))
        columns.extend(np.tile((source_faces[si, :, None] * 3 + np.arange(3)).ravel(), 3))
        values.extend(block.ravel())
    return sparse.coo_matrix((values, (rows, columns)), shape=(len(target_points), 3 * len(source_points))).tocsr()


def planar_face_flux_operator(source_points, source_faces, target_points, target_faces):
    """Map P1 Cartesian nodal velocity to one outward volume flux per quad face.

    G[a,3*s+j] = integral_face_a Ns * n[j] dA. Shared target vertices do not
    share flux rows. Dividing G @ velocity by each face area gives its mean
    normal velocity. Source winding may oppose the target outward winding.
    """
    source_faces, target_faces = np.asarray(source_faces, int), np.asarray(target_faces, int)
    if source_faces.ndim != 2 or source_faces.shape[1] != 3 or target_faces.ndim != 2 or target_faces.shape[1] != 4:
        raise ValueError("face flux coupling requires source tri3 and target quad4 faces")
    rows, columns, values = [], [], []
    for si, ti, source, _, triangle, area, normal in _planar_intersections(
        source_points, source_faces, target_points, target_faces,
    ):
        # A linear shape function integrates exactly at the overlap centroid.
        coordinates = np.linalg.solve((source[1:] - source[0]).T, triangle.mean(axis=0) - source[0])
        weights = np.array([1 - coordinates.sum(), *coordinates]) * area
        block = weights[:, None] * normal
        rows.extend([ti] * 9)
        columns.extend((source_faces[si, :, None] * 3 + np.arange(3)).ravel())
        values.extend(block.ravel())
    return sparse.coo_matrix((values, (rows, columns)), shape=(len(target_faces), 3 * len(source_points))).tocsr()
