"""Canonical solid sampling and exact closest points on triangle surfaces."""

import numpy as np
from scipy.spatial import cKDTree

from app.methods.structured.rasterize import rasterize_mesh_cell_centers


class SurfaceQuery:
    """Child-local acceleration; only mesh arrays belong in continuation state."""

    def __init__(self, mesh, *, surface_keys=None):
        self.triangles = np.asarray(mesh.vertices)[np.asarray(mesh.triangles)]
        self.centers = self.triangles.mean(axis=1)
        self.radius = np.linalg.norm(self.triangles - self.centers[:, None], axis=2).max(axis=1)
        self.tree = cKDTree(self.centers)
        cross = np.cross(self.triangles[:, 1] - self.triangles[:, 0],
                         self.triangles[:, 2] - self.triangles[:, 0])
        lengths = np.linalg.norm(cross, axis=1)
        if np.any(lengths == 0):
            raise ValueError("particle surfaces require nondegenerate triangles")
        self.normals = cross / lengths[:, None]
        keys = tuple(surface_keys) if surface_keys is not None else tuple(
            f"{item.source_node_id}:{item.surface_index}" for item in mesh.triangle_provenance
        ) if mesh.triangle_provenance else tuple(
            repr(tuple(np.round(np.r_[normal, np.dot(normal, triangle[0])], 12)))
            for normal, triangle in zip(self.normals, self.triangles, strict=True))
        # Boolean source provenance can split one smooth plane into several
        # authored surfaces. Join their adjacent coplanar patches for contact
        # purposes while retaining canonical surface grouping on curved faces.
        parent = {key: key for key in keys}

        def representative(key):
            while parent[key] != key:
                parent[key] = parent[parent[key]]
                key = parent[key]
            return key

        edges = {}
        for index, triangle in enumerate(np.asarray(mesh.triangles)):
            for first, second in ((0, 1), (1, 2), (2, 0)):
                edge = tuple(sorted((int(triangle[first]), int(triangle[second]))))
                neighbor = edges.get(edge)
                if neighbor is not None and np.dot(self.normals[index], self.normals[neighbor]) > 1 - 1e-12:
                    left, right = sorted((representative(keys[index]), representative(keys[neighbor])))
                    parent[right] = left
                edges[edge] = index
        self.surface_keys = tuple(representative(key) for key in keys)

    def contacts(self, point, radius):
        candidates = np.asarray(sorted(self.tree.query_ball_point(point, radius + self.radius.max())), dtype=int)
        if not len(candidates):
            return ()
        closest = triangle_closest_points(point, self.triangles[candidates])
        distance = np.linalg.norm(closest - point, axis=1)
        signed = np.einsum("ij,ij->i", point - closest, self.normals[candidates])
        nearest = int(np.argmin(distance))
        if distance[nearest] < radius and signed[nearest] < -radius * 1e-10:
            raise ValueError("particle center entered a fixed wall")
        selected = {}
        # A neighboring face can project to an edge behind its own outward
        # plane even while the sphere is outside the solid. It is not a contact.
        for row in np.flatnonzero((distance < radius) & (signed >= -radius * 1e-10)):
            index = candidates[row]
            key = self.surface_keys[index]
            if key not in selected or distance[row] < selected[key][1]:
                selected[key] = (closest[row], distance[row], self.normals[index], key)
        contacts = []
        for key in sorted(selected):
            contact = selected[key]
            # Two faces at a convex edge may have the same nearest point. That
            # point is one sphere-wall contact, independent of triangulation.
            if any(np.linalg.norm(contact[0] - existing[0]) <= radius * 1e-10 for existing in contacts):
                continue
            contacts.append(contact)
        return tuple(contacts)

    def closest(self, points):
        points = np.asarray(points, dtype=float).reshape(-1, 3)
        closest = np.empty_like(points)
        indices = np.empty(len(points), dtype=np.int64)
        for row, point in enumerate(points):
            _, seed = self.tree.query(point)
            first = triangle_closest_points(point, self.triangles[seed:seed + 1])[0]
            # Every potentially closer triangle has its centroid within this ball.
            radius = np.linalg.norm(point - first) + self.radius.max()
            candidates = np.asarray(sorted(self.tree.query_ball_point(point, radius * (1 + 1e-12))), dtype=int)
            projected = triangle_closest_points(point, self.triangles[candidates])
            index = np.argmin(np.sum((projected - point)**2, axis=1))
            closest[row], indices[row] = projected[index], candidates[index]
        distance = np.linalg.norm(points - closest, axis=1)
        return closest, distance, self.normals[indices], indices


def triangle_closest_points(point, triangles):
    """Project onto triangle interiors and all three bounded edges."""
    a, b, c = np.moveaxis(triangles, 1, 0)
    ab, ac = b - a, c - a
    normal = np.cross(ab, ac)
    normal_squared = np.einsum("ij,ij->i", normal, normal)
    projected = point - normal * (np.einsum("ij,ij->i", point - a, normal) / normal_squared)[:, None]
    d00, d01, d11 = (np.einsum("ij,ij->i", left, right) for left, right in ((ab, ab), (ab, ac), (ac, ac)))
    d20 = np.einsum("ij,ij->i", projected - a, ab)
    d21 = np.einsum("ij,ij->i", projected - a, ac)
    denominator = d00 * d11 - d01**2
    u = (d11 * d20 - d01 * d21) / denominator
    v = (d00 * d21 - d01 * d20) / denominator
    candidates = [projected]
    for start, end in ((a, b), (b, c), (c, a)):
        edge = end - start
        fraction = np.clip(np.einsum("ij,ij->i", point - start, edge) /
                           np.einsum("ij,ij->i", edge, edge), 0, 1)
        candidates.append(start + fraction[:, None] * edge)
    candidates = np.stack(candidates, axis=1)
    distances = np.sum((candidates - point)**2, axis=2)
    distances[(u < 0) | (v < 0) | (u + v > 1), 0] = np.inf
    return candidates[np.arange(len(triangles)), distances.argmin(axis=1)]


def closest_surface(mesh, points):
    return SurfaceQuery(mesh).closest(points)


async def sample_mesh_lattice(mesh, spacing, *, clearance=0.0, origin=None):
    """Sample the actual closed solid, preserving Boolean holes and cavities."""
    spacing = float(spacing)
    if not np.isfinite(spacing) or spacing <= 0 or not np.isfinite(clearance) or clearance < 0:
        raise ValueError("particle spacing must be positive and clearance nonnegative")
    lower, upper = np.min(mesh.vertices, axis=0), np.max(mesh.vertices, axis=0)
    if origin is None:
        counts = np.maximum(1, np.floor((upper - lower - 2 * clearance) / spacing + 1e-10).astype(int) + 1)
        if clearance == 0:
            counts = np.maximum(1, np.floor((upper - lower) / spacing + 1e-10).astype(int))
        starts = (lower + upper - (counts - 1) * spacing) / 2
    else:
        starts = np.asarray(origin) + np.ceil((lower + clearance - origin) / spacing - 1e-10) * spacing
        counts = np.maximum(0, np.floor((upper - clearance - starts) / spacing + 1e-10).astype(int) + 1)
    axes = tuple(start + np.arange(count) * spacing for start, count in zip(starts, counts, strict=True))
    mask = await rasterize_mesh_cell_centers(mesh, *axes)
    iz, iy, ix = np.nonzero(mask)
    points = np.column_stack((axes[0][ix], axes[1][iy], axes[2][iz]))
    if clearance and len(points):
        _, distance, _, _ = closest_surface(mesh, points)
        points = points[distance >= clearance * (1 - 1e-9)]
    return points
