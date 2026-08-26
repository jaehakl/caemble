from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from app.methods.geometry import TriangularMesh

from app.methods.optics import unit_vector


@dataclass(frozen=True, slots=True)
class TriangleMetadata:
    kind: str
    root_id: str
    material_name: str | None = None
    payload: Any = None


@dataclass(frozen=True, slots=True)
class RayHit:
    distance: float
    position: np.ndarray[Any, Any]
    normal: np.ndarray[Any, Any]
    barycentric: np.ndarray[Any, Any]
    triangle_index: int
    local_triangle_index: int
    metadata: TriangleMetadata


@dataclass(slots=True)
class _BvhNode:
    minimum: np.ndarray[Any, Any]
    maximum: np.ndarray[Any, Any]
    indices: np.ndarray[Any, Any] | None = None
    left: _BvhNode | None = None
    right: _BvhNode | None = None


class TriangleScene:
    def __init__(self) -> None:
        self._triangles: list[np.ndarray[Any, Any]] = []
        self._metadata: list[TriangleMetadata] = []
        self._local_indices: list[int] = []
        self.triangles = np.empty((0, 3, 3), dtype=np.float64)
        self.normals = np.empty((0, 3), dtype=np.float64)
        self.minimum = np.zeros(3)
        self.maximum = np.zeros(3)
        self._root: _BvhNode | None = None

    def add_mesh(
        self,
        mesh: TriangularMesh,
        metadata: TriangleMetadata | list[TriangleMetadata],
        triangle_indices: np.ndarray[Any, Any] | None = None,
    ) -> None:
        indices = np.arange(len(mesh.triangles), dtype=np.int64) if triangle_indices is None else triangle_indices
        for ordinal, local_index in enumerate(indices):
            self._triangles.append(mesh.vertices[mesh.triangles[int(local_index)]])
            self._metadata.append(metadata[ordinal] if isinstance(metadata, list) else metadata)
            self._local_indices.append(int(local_index))

    def build(self) -> None:
        self.triangles = np.ascontiguousarray(self._triangles, dtype=np.float64)
        first = self.triangles[:, 1] - self.triangles[:, 0]
        second = self.triangles[:, 2] - self.triangles[:, 0]
        normals = np.cross(first, second)
        lengths = np.linalg.norm(normals, axis=1)
        self.normals = normals / lengths[:, None]
        self.minimum = np.min(self.triangles, axis=(0, 1))
        self.maximum = np.max(self.triangles, axis=(0, 1))
        triangle_minimum = np.min(self.triangles, axis=1)
        triangle_maximum = np.max(self.triangles, axis=1)
        centroids = np.mean(self.triangles, axis=1)

        def build_node(indices: np.ndarray[Any, Any]) -> _BvhNode:
            minimum = np.min(triangle_minimum[indices], axis=0)
            maximum = np.max(triangle_maximum[indices], axis=0)
            if len(indices) <= 16:
                return _BvhNode(minimum, maximum, indices=indices)
            extent = np.ptp(centroids[indices], axis=0)
            axis = int(np.argmax(extent))
            order = indices[np.argsort(centroids[indices, axis], kind="stable")]
            middle = len(order) // 2
            return _BvhNode(
                minimum,
                maximum,
                left=build_node(order[:middle]),
                right=build_node(order[middle:]),
            )

        self._root = build_node(np.arange(len(self.triangles), dtype=np.int64))

    @property
    def diagonal(self) -> float:
        return float(np.linalg.norm(self.maximum - self.minimum))

    def intersect(
        self,
        origin: np.ndarray[Any, Any],
        direction: np.ndarray[Any, Any],
        minimum_distance: float,
    ) -> RayHit | None:
        if self._root is None:
            raise RuntimeError("TriangleScene.build() must be called before tracing")
        inverse = np.divide(
            1.0,
            direction,
            out=np.full(3, math.inf),
            where=np.abs(direction) > 1e-30,
        )
        nearest = math.inf
        selected = -1
        selected_priority = -1
        selected_u = 0.0
        selected_v = 0.0
        tie_tolerance = max(1e-15, minimum_distance * 0.5, self.diagonal * 1e-12)
        stack = [self._root]
        while stack:
            node = stack.pop()
            first = (node.minimum - origin) * inverse
            second = (node.maximum - origin) * inverse
            near = float(np.max(np.minimum(first, second)))
            far = float(np.min(np.maximum(first, second)))
            if far < max(near, minimum_distance) or near > nearest + tie_tolerance:
                continue
            if node.indices is None:
                if node.left is not None:
                    stack.append(node.left)
                if node.right is not None:
                    stack.append(node.right)
                continue
            triangles = self.triangles[node.indices]
            edge1 = triangles[:, 1] - triangles[:, 0]
            edge2 = triangles[:, 2] - triangles[:, 0]
            cross = np.cross(np.broadcast_to(direction, edge2.shape), edge2)
            determinant = np.einsum("ij,ij->i", edge1, cross)
            valid = np.abs(determinant) > 1e-14
            reciprocal = np.zeros_like(determinant)
            reciprocal[valid] = 1 / determinant[valid]
            relative = origin - triangles[:, 0]
            u_value = np.einsum("ij,ij->i", relative, cross) * reciprocal
            valid &= (u_value >= -1e-12) & (u_value <= 1 + 1e-12)
            second_cross = np.cross(relative, edge1)
            v_value = np.einsum("j,ij->i", direction, second_cross) * reciprocal
            valid &= (v_value >= -1e-12) & (u_value + v_value <= 1 + 1e-12)
            distances = np.einsum("ij,ij->i", edge2, second_cross) * reciprocal
            valid &= (distances > minimum_distance) & (distances <= nearest + tie_tolerance)
            if not np.any(valid):
                continue
            for local in np.flatnonzero(valid):
                distance = float(distances[local])
                triangle_index = int(node.indices[local])
                priority = 1 if self._metadata[triangle_index].kind.startswith("thin-stack") else 0
                tied = abs(distance - nearest) <= tie_tolerance
                if distance < nearest - tie_tolerance or (
                    tied and (priority > selected_priority or (priority == selected_priority and distance < nearest))
                ):
                    nearest = distance
                    selected = triangle_index
                    selected_priority = priority
                    selected_u = float(u_value[local])
                    selected_v = float(v_value[local])
        if selected < 0:
            return None
        barycentric = np.array([1 - selected_u - selected_v, selected_u, selected_v], dtype=np.float64)
        return RayHit(
            nearest,
            origin + direction * nearest,
            self.normals[selected].copy(),
            barycentric,
            selected,
            self._local_indices[selected],
            self._metadata[selected],
        )


class SurfaceSampler:
    def __init__(self, mesh: TriangularMesh, triangle_indices: np.ndarray[Any, Any]) -> None:
        self.triangles = mesh.vertices[mesh.triangles[triangle_indices]]
        cross = np.cross(self.triangles[:, 1] - self.triangles[:, 0], self.triangles[:, 2] - self.triangles[:, 0])
        lengths = np.linalg.norm(cross, axis=1)
        self.normals = cross / lengths[:, None]
        self.cumulative_area = np.cumsum(lengths / 2)
        self.area = float(self.cumulative_area[-1])

    def sample(self, area_value: float, first: float, second: float) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]:
        index = min(
            len(self.triangles) - 1,
            int(np.searchsorted(self.cumulative_area, area_value * self.area, side="right")),
        )
        root = math.sqrt(first)
        weights = np.array([1 - root, root * (1 - second), root * second])
        return weights @ self.triangles[index], self.normals[index].copy()


def counter_random(seed: int, *coordinates: int) -> float:
    value = seed & 0xFFFFFFFFFFFFFFFF
    for coordinate in coordinates:
        value ^= int(coordinate) & 0xFFFFFFFFFFFFFFFF
        value = (value + 0x9E3779B97F4A7C15) & 0xFFFFFFFFFFFFFFFF
        value = ((value ^ (value >> 30)) * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
        value = ((value ^ (value >> 27)) * 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
        value ^= value >> 31
    return (value >> 11) * (1.0 / (1 << 53))


def vector_parameter(value: Any, path: str) -> np.ndarray[Any, Any]:
    raw = value.get("value") if isinstance(value, dict) else value
    return unit_vector(raw, path)
