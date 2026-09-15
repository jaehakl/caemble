"""Triangle-surface proximity for rigid solids, without convex-hull replacement.

FCL supplies BVH distances. Contact normals come from oriented surface features,
not triangle-intersection penetration depths (which do not describe solid depth).
"""

from itertools import combinations

import fcl
import manifold3d
import numpy as np
from scipy.spatial import cKDTree

from app.methods.rigid import quaternion_to_matrix


def closest_on_triangles(points, triangles):
    """Vectorized point/triangle witnesses, including edge and vertex regions."""
    a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    ab, ac = b - a, c - a
    normal = np.cross(ab, ac)
    squared = np.einsum("ij,ij->i", normal, normal)
    projection = points - normal * (np.einsum("ij,ij->i", points - a, normal) / squared)[:, None]
    ap = projection - a
    u = np.einsum("ij,ij->i", np.cross(ap, ac), normal) / squared
    v = np.einsum("ij,ij->i", np.cross(ab, ap), normal) / squared
    inside = (u >= 0) & (v >= 0) & (u + v <= 1)
    witnesses = []
    for first, last in ((a, b), (b, c), (c, a)):
        edge = last - first
        t = np.clip(np.einsum("ij,ij->i", points - first, edge) / np.einsum("ij,ij->i", edge, edge), 0.0, 1.0)
        witnesses.append(first + t[:, None] * edge)
    choices = np.stack(witnesses, axis=1)
    best = np.argmin(np.sum((choices - points[:, None]) ** 2, axis=2), axis=1)
    closest = choices[np.arange(len(points)), best]
    closest[inside] = projection[inside]
    return closest


def segment_witnesses(a, b, c, d):
    """Closest points for batched segment pairs, including parallel edges."""
    u, v, w = b - a, d - c, a - c
    uu, vv = np.sum(u * u, axis=1), np.sum(v * v, axis=1)
    uv, uw, vw = np.sum(u * v, axis=1), np.sum(u * w, axis=1), np.sum(v * w, axis=1)
    denominator = uu * vv - uv * uv
    s = np.zeros(len(a))
    np.divide(uv * vw - vv * uw, denominator, out=s, where=denominator > 1e-14 * uu * vv)
    s = np.clip(s, 0.0, 1.0)
    t = np.clip((uv * s + vw) / vv, 0.0, 1.0)
    s = np.clip((uv * t - uw) / uu, 0.0, 1.0)
    return a + s[:, None] * u, c + t[:, None] * v


class CollisionScene:
    """Child-local acceleration structures; only meshes/poses enter checkpoints."""

    def __init__(self, model, tolerance):
        self.model = model
        self.tolerance = tolerance
        self.local, self.faces, self.vertex_normals, self.edges, self.objects = [], [], [], [], []
        self.radii = []
        for body in range(len(model["masses"])):
            v0, v1 = model["vertexOffsets"][body : body + 2]
            f0, f1 = model["triangleOffsets"][body : body + 2]
            vertices = np.ascontiguousarray(model["vertices"][v0:v1] - model["localCenters"][body])
            faces = np.ascontiguousarray(model["triangles"][f0:f1] - v0, dtype=np.int32)
            triangles = vertices[faces]
            normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
            vertex_normals = np.zeros_like(vertices)
            for corner in range(3):
                np.add.at(vertex_normals, faces[:, corner], normals)
            vertex_normals /= np.linalg.norm(vertex_normals, axis=1)[:, None]
            mesh = fcl.BVHModel()
            mesh.beginModel(len(faces), len(vertices))
            mesh.addSubModel(vertices, faces)
            mesh.endModel()
            self.objects.append(fcl.CollisionObject(mesh))
            self.local.append(vertices)
            self.faces.append(faces)
            self.vertex_normals.append(vertex_normals)
            all_edges = np.sort(
                np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1
            )
            edges, inverse = np.unique(all_edges, axis=0, return_inverse=True)
            unit_normals = normals / np.linalg.norm(normals, axis=1)[:, None]
            edge_normals = np.zeros((len(edges), 3))
            np.add.at(edge_normals, inverse, np.tile(unit_normals, (3, 1)))
            counts = np.bincount(inverse)
            # Coplanar triangulation diagonals are not physical contact edges.
            self.edges.append(edges[np.linalg.norm(edge_normals, axis=1) < counts - 1e-10])
            self.radii.append(float(np.linalg.norm(vertices, axis=1).max()))
        self.radii = np.asarray(self.radii)
        self.pairs = [
            (i, j)
            for i, j in combinations(range(len(self.local)), 2)
            if not (model["static"][i] and model["static"][j])
        ]

    def place(self, state):
        rotations = quaternion_to_matrix(state["orientation"])
        self.world = [
            local @ rotation.T + position
            for local, rotation, position in zip(self.local, rotations, state["position"], strict=True)
        ]
        self.normals = [
            normals @ rotation.T for normals, rotation in zip(self.vertex_normals, rotations, strict=True)
        ]
        for body, obj in enumerate(self.objects):
            obj.setTransform(fcl.Transform(rotations[body], state["position"][body]))
        self.bounds = [(vertices.min(axis=0), vertices.max(axis=0)) for vertices in self.world]

    def distance(self, first, second):
        request = fcl.DistanceRequest(enable_nearest_points=True)
        result = fcl.DistanceResult()
        distance = fcl.distance(self.objects[first], self.objects[second], request, result)
        if not np.isfinite(distance):
            raise ValueError("rigid collision distance is nonfinite")
        return max(0.0, distance)

    def penetration(self, state):
        """Estimate overlap thickness from the actual solid intersection."""
        self.place(state)
        maximum = 0.0
        for i, j in self.pairs:
            lo = np.maximum(self.bounds[i][0], self.bounds[j][0])
            hi = np.minimum(self.bounds[i][1], self.bounds[j][1])
            if np.any(hi - lo <= self.tolerance):
                continue
            solids = [
                manifold3d.Manifold(
                    manifold3d.Mesh64(
                        np.ascontiguousarray(self.world[k]),
                        np.ascontiguousarray(self.faces[k], dtype=np.uint64),
                    )
                )
                for k in (i, j)
            ]
            overlap = solids[0] ^ solids[1]
            area = overlap.surface_area()
            if area > 0:
                maximum = max(maximum, 2.0 * overlap.volume() / area)
        return maximum

    def initial_overlap(self, state):
        if self.penetration(state) > self.tolerance:
            raise ValueError("initial rigid solids overlap beyond the contact tolerance")

    def contacts(self):
        contacts = []
        distance_limit = 2.0 * self.tolerance
        for i, j in self.pairs:
            if np.any(self.bounds[i][1] + distance_limit < self.bounds[j][0]) or np.any(
                self.bounds[j][1] + distance_limit < self.bounds[i][0]
            ):
                continue
            candidates = []
            for source, target, sign in ((i, j, 1.0), (j, i, -1.0)):
                triangles = self.world[target][self.faces[target]]
                centers = triangles.mean(axis=1)
                radii = np.linalg.norm(triangles - centers[:, None], axis=2).max(axis=1)
                tree = cKDTree(centers)
                points = self.world[source]
                indices = np.flatnonzero(
                    np.all(
                        (points >= self.bounds[target][0] - distance_limit)
                        & (points <= self.bounds[target][1] + distance_limit),
                        axis=1,
                    )
                )
                pairs = [
                    (index, face)
                    for index in indices
                    for face in tree.query_ball_point(points[index], float(radii.max()) + distance_limit)
                    if np.linalg.norm(points[index] - centers[face]) <= radii[face] + distance_limit
                ]
                if not pairs:
                    continue
                vertices, faces = np.asarray(pairs).T
                raw = triangles[faces]
                normal = np.cross(raw[:, 1] - raw[:, 0], raw[:, 2] - raw[:, 0])
                normal /= np.linalg.norm(normal, axis=1)[:, None]
                witness = closest_on_triangles(points[vertices], raw)
                gap = np.einsum("ij,ij->i", points[vertices] - witness, normal)
                valid = (np.linalg.norm(points[vertices] - witness, axis=1) <= distance_limit) & (
                    np.einsum("ij,ij->i", self.normals[source][vertices], normal) < -0.05
                )
                for k in np.flatnonzero(valid):
                    candidates.append(
                        ((points[vertices[k]] + witness[k]) * 0.5, -sign * normal[k], float(gap[k]))
                    )
            # Edge/edge witnesses cover contacts with no vertex over a face interior.
            first_edges, second_edges = self.world[i][self.edges[i]], self.world[j][self.edges[j]]
            midpoints = second_edges.mean(axis=1)
            radii = np.linalg.norm(second_edges[:, 1] - second_edges[:, 0], axis=1) * 0.5
            tree = cKDTree(midpoints)
            pairs = []
            for edge, endpoints in enumerate(first_edges):
                center = endpoints.mean(axis=0)
                radius = np.linalg.norm(endpoints[1] - endpoints[0]) * 0.5
                for other in tree.query_ball_point(center, float(radius + radii.max() + distance_limit)):
                    if np.linalg.norm(center - midpoints[other]) <= radius + radii[other] + distance_limit:
                        pairs.append((edge, other))
            if pairs:
                ea, eb = np.asarray(pairs).T
                a, b = first_edges[ea, 0], first_edges[ea, 1]
                c, d = second_edges[eb, 0], second_edges[eb, 1]
                pa, pb = segment_witnesses(a, b, c, d)
                delta = pb - pa
                lengths = np.linalg.norm(delta, axis=1)
                interior = (
                    (np.linalg.norm(pa - a, axis=1) > self.tolerance)
                    & (np.linalg.norm(pa - b, axis=1) > self.tolerance)
                    & (np.linalg.norm(pb - c, axis=1) > self.tolerance)
                    & (np.linalg.norm(pb - d, axis=1) > self.tolerance)
                )
                for k in np.flatnonzero((lengths <= distance_limit) & interior):
                    na = self.normals[i][self.edges[i][ea[k]]].sum(axis=0)
                    nb = self.normals[j][self.edges[j][eb[k]]].sum(axis=0)
                    if lengths[k] > self.tolerance * 0.01:
                        normal = delta[k] / lengths[k]
                    else:
                        normal = np.cross(b[k] - a[k], d[k] - c[k])
                        size = np.linalg.norm(normal)
                        if size <= 1e-14 * np.linalg.norm(b[k] - a[k]) * np.linalg.norm(d[k] - c[k]):
                            continue
                        normal /= size
                        if normal @ na < 0:
                            normal = -normal
                    if normal @ na > 0 and normal @ nb < 0:
                        candidates.append(((pa[k] + pb[k]) * 0.5, normal, float(lengths[k])))
            patches = {}
            for point, normal, gap in candidates:
                key = tuple(np.round(normal * 20).astype(int))
                patches.setdefault(key, []).append((point, normal, gap))
            for values in patches.values():
                # Farthest-point reduction preserves the support polygon rather than triangle count.
                chosen = [min(values, key=lambda item: item[2])]
                for _ in range(3):
                    candidate = max(
                        values, key=lambda item: min(np.linalg.norm(item[0] - old[0]) for old in chosen)
                    )
                    if min(np.linalg.norm(candidate[0] - old[0]) for old in chosen) <= self.tolerance:
                        break
                    chosen.append(candidate)
                contacts.extend(
                    {"first": i, "second": j, "point": p, "normal": n, "gap": gap} for p, n, gap in chosen
                )
        return contacts
