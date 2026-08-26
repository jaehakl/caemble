from __future__ import annotations

import asyncio
import json
import math
from dataclasses import dataclass
from decimal import Decimal
from types import MappingProxyType
from typing import Any, Awaitable, Callable

import manifold3d as manifold
import numpy as np

from app.solver_framework.geometry.models import ShellLayerGeometry, TriangleProvenance, TriangularMesh
from app.solver_framework.units import convert_ucum_value

_BACKEND_VERSION = "manifold3d-3.5.1"
_MESHING_PROFILE = "canonical-v1"


@dataclass(frozen=True, slots=True)
class _CompiledGeometry:
    solid: manifold.Manifold
    provenance: dict[tuple[int, int], tuple[str, int]]


@dataclass(frozen=True, slots=True)
class _ShellBoundaryData:
    world_center: np.ndarray[Any, Any]
    triangles: np.ndarray[Any, Any]
    displacements: np.ndarray[Any, Any]
    boundaries: dict[float, np.ndarray[Any, Any]]


class GeometryService:
    """Run-scoped access to canonical geometry and shared triangulation."""

    def __init__(self) -> None:
        self._meshes: dict[tuple[str, str, str, str, str], TriangularMesh] = {}
        self._shell_layers: dict[tuple[str, str, str, str], ShellLayerGeometry] = {}

    @property
    def cached_mesh_count(self) -> int:
        return len(self._meshes)

    def scene(self, scene: dict[str, Any]) -> MappingProxyType[str, Any]:
        return _immutable(scene)

    def root(self, scene: dict[str, Any], root_id: str) -> MappingProxyType[str, Any]:
        return _immutable(next(root for root in scene["roots"] if root["id"] == root_id))

    def geometry_group(self, scene: dict[str, Any], name: str) -> MappingProxyType[str, Any]:
        return _immutable(next(group for group in scene["geometryGroups"] if group["name"] == name))

    def surface_group(self, scene: dict[str, Any], name: str) -> MappingProxyType[str, Any]:
        return _immutable(next(group for group in scene["surfaceGroups"] if group["name"] == name))

    def selectors(self, scene: dict[str, Any], name: str) -> tuple[MappingProxyType[str, Any], ...]:
        group = self.surface_group(scene, name)
        return group["selectors"]

    async def triangular_mesh(
        self,
        scene: dict[str, Any],
        root_id: str,
        reference_length_unit: str,
        progress: Callable[[Any], Awaitable[None]] | None = None,
    ) -> TriangularMesh:
        key = (
            scene["geometryHash"],
            root_id,
            reference_length_unit,
            _BACKEND_VERSION,
            _MESHING_PROFILE,
        )
        cached = self._meshes.get(key)
        if cached is not None:
            return cached
        root = next(root for root in scene["roots"] if root["id"] == root_id)
        if progress is not None:
            await progress({"stage": "geometry", "completed": 0, "total": 1})
        await asyncio.sleep(0)
        context = manifold.ExecutionContext()
        compiled = _compile_node(root["node"], context)
        output = compiled.solid.to_mesh64()
        vertices = np.asarray(output.vert_properties, dtype=np.float64)[:, :3].copy()
        triangles = np.asarray(output.tri_verts, dtype=np.int64).copy()
        provenance = _output_provenance(output, compiled.provenance, root_id)
        scale = _length_scale(scene["lengthUnit"], reference_length_unit, root_id)
        vertices *= scale
        vertices.setflags(write=False)
        triangles.setflags(write=False)
        result = TriangularMesh(vertices, triangles, provenance)
        existing = self._meshes.get(key)
        if existing is not None:
            return existing
        self._meshes[key] = result
        if progress is not None:
            await progress({"stage": "geometry", "completed": 1, "total": 1})
        return result

    async def shell_layer(
        self,
        scene: dict[str, Any],
        root_id: str,
        reference_length_unit: str,
        progress: Callable[[Any], Awaitable[None]] | None = None,
    ) -> ShellLayerGeometry | None:
        key = (scene["geometryHash"], root_id, reference_length_unit, _MESHING_PROFILE)
        cached = self._shell_layers.get(key)
        if cached is not None:
            return cached
        root = next(root for root in scene["roots"] if root["id"] == root_id)
        direct = _direct_shell(root["node"])
        if direct is None:
            return None
        shell, outer_matrix = direct
        if progress is not None:
            await progress({"stage": "geometry", "completed": 0, "total": 1})
        await asyncio.sleep(0)
        context = manifold.ExecutionContext()
        child = _compile_node(shell["child"], context)
        data = _shell_boundary_data(
            child,
            (float(shell["innerOffset"]), float(shell["outerOffset"])),
            context,
        )
        scale = _length_scale(scene["lengthUnit"], reference_length_unit, root_id)
        linear = outer_matrix[:3, :3] * scale
        reverses_orientation = float(np.linalg.det(linear)) < 0

        def boundary(offset: float, surface_index: int) -> TriangularMesh:
            points = data.boundaries[offset] + data.world_center
            homogeneous = np.concatenate((points, np.ones((len(points), 1))), axis=1)
            vertices = (homogeneous @ outer_matrix.T)[:, :3] * scale
            vertices = np.ascontiguousarray(vertices, dtype=np.float64)
            triangle_indices = data.triangles[:, [0, 2, 1]] if reverses_orientation else data.triangles
            triangles = np.ascontiguousarray(triangle_indices, dtype=np.int64)
            vertices.setflags(write=False)
            triangles.setflags(write=False)
            provenance = tuple(
                TriangleProvenance(root_id, shell["nodeId"], surface_index)
                for _ in range(len(triangles))
            )
            return TriangularMesh(vertices, triangles, provenance)

        inner_offset = float(shell["innerOffset"])
        outer_offset = float(shell["outerOffset"])
        inner = boundary(inner_offset, 0)
        outer = boundary(outer_offset, 1)
        inner_triangles = inner.vertices[inner.triangles]
        outer_triangles = outer.vertices[outer.triangles]
        inner_normals = np.cross(
            inner_triangles[:, 1] - inner_triangles[:, 0],
            inner_triangles[:, 2] - inner_triangles[:, 0],
        )
        outer_normals = np.cross(
            outer_triangles[:, 1] - outer_triangles[:, 0],
            outer_triangles[:, 2] - outer_triangles[:, 0],
        )
        inner_normal_lengths = np.linalg.norm(inner_normals, axis=1)
        outer_normal_lengths = np.linalg.norm(outer_normals, axis=1)
        inner_normals /= inner_normal_lengths[:, None]
        outer_normals /= outer_normal_lengths[:, None]
        offset_span = float(abs(Decimal(str(outer_offset)) - Decimal(str(inner_offset))))
        transformed_displacements = data.displacements @ linear.T * offset_span
        triangle_displacements = transformed_displacements[data.triangles]
        separations = np.concatenate(
            (
                np.abs(np.einsum("ijk,ik->ij", triangle_displacements, inner_normals)).reshape(-1),
                np.abs(np.einsum("ijk,ik->ij", triangle_displacements, outer_normals)).reshape(-1),
            )
        )
        family_id = json.dumps(
            [shell["child"]["nodeId"], outer_matrix.tolist()],
            separators=(",", ":"),
        )
        result = ShellLayerGeometry(
            root_id=root_id,
            family_id=family_id,
            inner_offset=inner_offset,
            outer_offset=outer_offset,
            inner=inner,
            outer=outer,
            minimum_thickness=float(np.min(separations)),
            maximum_thickness=float(np.max(separations)),
        )
        existing = self._shell_layers.get(key)
        if existing is not None:
            return existing
        self._shell_layers[key] = result
        if progress is not None:
            await progress({"stage": "geometry", "completed": 1, "total": 1})
        return result


def _compile_node(node: dict[str, Any], context: manifold.ExecutionContext) -> _CompiledGeometry:
    kind = node["kind"]
    if kind == "primitive":
        parameters = node["parameters"]
        primitive = node["primitive"]
        if primitive == "box":
            solid = manifold.Manifold.cube(parameters["size"], center=True)
        elif primitive == "cylinder":
            solid = manifold.Manifold.cylinder(
                parameters["height"],
                parameters["radius"],
                parameters["radius_2"],
                parameters["segments"],
                center=True,
            )
        elif primitive == "sphere":
            solid = manifold.Manifold.sphere(parameters["radius"], parameters["segments"])
        elif primitive == "curvedEdgeCylinder":
            vertices, triangles, surface_indices = _curved_edge_cylinder(parameters)
            return _from_indexed(vertices, triangles, surface_indices, node["nodeId"], context)
        else:
            vertices, triangles = _curved_surface_sphere(parameters)
            return _from_indexed(
                vertices,
                triangles,
                [0] * triangles.shape[0],
                node["nodeId"],
                context,
            )
        return _primitive(solid, node["nodeId"], primitive, parameters)
    if kind == "fiber":
        vertices, triangles, surface_indices = _fiber(node)
        return _from_indexed(vertices, triangles, surface_indices, node["nodeId"], context)
    if kind in {"transform", "instance"}:
        child = _compile_node(node["child"], context)
        matrix = node["matrix"]
        transformed = child.solid.transform(
            [
                matrix[0:4],
                matrix[4:8],
                matrix[8:12],
            ]
        )
        return _CompiledGeometry(transformed, child.provenance)
    if kind == "boolean":
        children = [_compile_node(child, context) for child in node["children"]]
        operation = {
            "union": manifold.OpType.Add,
            "subtract": manifold.OpType.Subtract,
            "intersect": manifold.OpType.Intersect,
        }[node["operation"]]
        solid = manifold.Manifold.batch_boolean([child.solid for child in children], operation)
        provenance = {
            item: provenance
            for child in children
            for item, provenance in child.provenance.items()
        }
        return _CompiledGeometry(solid, provenance)
    child = _compile_node(node["child"], context)
    return _shell(child, node["nodeId"], node["innerOffset"], node["outerOffset"], context)


def _primitive(
    solid: manifold.Manifold,
    node_id: str,
    primitive: str,
    parameters: dict[str, Any],
) -> _CompiledGeometry:
    solid = solid.as_original()
    output = solid.to_mesh64()
    vertices = np.asarray(output.vert_properties, dtype=np.float64)[:, :3]
    triangles = np.asarray(output.tri_verts, dtype=np.int64)
    face_ids = np.asarray(output.face_id, dtype=np.uint64)
    original_id = int(output.run_original_id[0])
    result: dict[tuple[int, int], tuple[str, int]] = {}
    for index, triangle in enumerate(triangles):
        if primitive in {"sphere", "curvedSurfaceSphere"}:
            surface_index = 0
        else:
            points = vertices[triangle]
            normal = np.cross(points[1] - points[0], points[2] - points[0])
            normal /= np.linalg.norm(normal)
            if primitive == "box":
                axis = int(np.argmax(np.abs(normal)))
                surface_index = axis * 2 + int(normal[axis] > 0)
            else:
                height = abs(parameters["height"])
                tolerance = min(max(height * 1e-10, 1e-12), height / 4)
                if np.all(np.abs(points[:, 2] + height / 2) <= tolerance):
                    surface_index = 0
                elif np.all(np.abs(points[:, 2] - height / 2) <= tolerance):
                    surface_index = 2
                else:
                    surface_index = 1
        key = (original_id, int(face_ids[index]))
        result[key] = (node_id, surface_index)
    return _CompiledGeometry(solid, result)


def _from_indexed(
    vertices: np.ndarray[Any, Any],
    triangles: np.ndarray[Any, Any],
    surface_indices: list[int],
    node_id: str,
    context: manifold.ExecutionContext,
) -> _CompiledGeometry:
    face_ids_by_surface: dict[int, int] = {}
    face_ids = np.empty(len(surface_indices), dtype=np.uint64)
    for index, surface_index in enumerate(surface_indices):
        face_ids[index] = face_ids_by_surface.setdefault(surface_index, len(face_ids_by_surface))
    mesh = manifold.Mesh64(
        np.ascontiguousarray(vertices, dtype=np.float64),
        np.ascontiguousarray(triangles, dtype=np.uint64),
        face_id=face_ids,
    )
    solid = context.from_mesh(mesh)
    output = solid.to_mesh64()
    original_id = int(output.run_original_id[0])
    return _CompiledGeometry(
        solid,
        {
            (original_id, face_id): (node_id, surface_index)
            for surface_index, face_id in face_ids_by_surface.items()
        },
    )

def _output_provenance(
    output: manifold.Mesh64,
    provenance_by_face: dict[tuple[int, int], tuple[str, int]],
    root_id: str,
) -> tuple[TriangleProvenance, ...]:
    result: list[TriangleProvenance] = []
    run_index = np.asarray(output.run_index, dtype=np.int64) // 3
    for run, original_id in enumerate(output.run_original_id):
        for triangle_index in range(int(run_index[run]), int(run_index[run + 1])):
            provenance = provenance_by_face[(int(original_id), int(output.face_id[triangle_index]))]
            result.append(TriangleProvenance(root_id, provenance[0], provenance[1]))
    return tuple(result)


def _curved_edge_cylinder(
    parameters: dict[str, Any],
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any], list[int]]:
    azimuthal_segments = parameters["azimuthalSegments"]
    vertical_segments = parameters["verticalSegments"]
    height = parameters["height"]
    vertices: list[list[float]] = []
    for vertical_index in range(vertical_segments + 1):
        z = -height / 2 + height * vertical_index / vertical_segments
        offset = z - parameters["verticalCurve"]["origin"]
        vertical_radius = 0.0
        for coefficient in reversed(parameters["verticalCurve"]["coefficients"]):
            vertical_radius = vertical_radius * offset + coefficient
        for azimuthal_index in range(azimuthal_segments):
            theta = 2 * math.pi * azimuthal_index / azimuthal_segments
            azimuthal_radius = sum(
                mode["amplitude"] * math.cos(mode_index * theta + mode["phase"])
                for mode_index, mode in enumerate(parameters["azimuthalCurve"])
            )
            radius = azimuthal_radius * vertical_radius
            vertices.append([radius * math.cos(theta), radius * math.sin(theta), z])
    bottom_center = len(vertices)
    vertices.append([0.0, 0.0, -height / 2])
    top_center = len(vertices)
    vertices.append([0.0, 0.0, height / 2])
    triangles: list[list[int]] = []
    surface_indices: list[int] = []
    for azimuthal_index in range(azimuthal_segments):
        following = (azimuthal_index + 1) % azimuthal_segments
        triangles.append([bottom_center, following, azimuthal_index])
        surface_indices.append(0)
        top_start = vertical_segments * azimuthal_segments
        triangles.append([top_center, top_start + azimuthal_index, top_start + following])
        surface_indices.append(2)
    for vertical_index in range(vertical_segments):
        lower = vertical_index * azimuthal_segments
        upper = lower + azimuthal_segments
        for azimuthal_index in range(azimuthal_segments):
            following = (azimuthal_index + 1) % azimuthal_segments
            triangles.extend(
                ([lower + azimuthal_index, lower + following, upper + following],
                 [lower + azimuthal_index, upper + following, upper + azimuthal_index])
            )
            surface_indices.extend((1, 1))
    return np.asarray(vertices), np.asarray(triangles, dtype=np.uint64), surface_indices


def _curved_surface_sphere(
    parameters: dict[str, Any],
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    azimuthal_segments = parameters["azimuthalSegments"]
    polar_segments = parameters["polarSegments"]

    def point(theta: float, phi: float) -> list[float]:
        azimuthal_radius = sum(
            mode["amplitude"] * math.cos(mode_index * theta + mode["phase"])
            for mode_index, mode in enumerate(parameters["azimuthalCurve"])
        )
        polar_radius = sum(
            mode["amplitude"] * math.cos(mode_index * phi + mode["phase"])
            for mode_index, mode in enumerate(parameters["polarCurve"])
        )
        radius = azimuthal_radius * polar_radius
        radial = radius * math.sin(phi)
        return [radial * math.cos(theta), radial * math.sin(theta), radius * math.cos(phi)]

    vertices = [point(0, 0)]
    for polar_index in range(1, polar_segments):
        phi = math.pi * polar_index / polar_segments
        for azimuthal_index in range(azimuthal_segments):
            vertices.append(point(2 * math.pi * azimuthal_index / azimuthal_segments, phi))
    south = len(vertices)
    vertices.append(point(0, math.pi))
    triangles: list[list[int]] = []
    for azimuthal_index in range(azimuthal_segments):
        following = (azimuthal_index + 1) % azimuthal_segments
        triangles.append([0, 1 + azimuthal_index, 1 + following])
    for polar_index in range(1, polar_segments - 1):
        upper = 1 + (polar_index - 1) * azimuthal_segments
        lower = upper + azimuthal_segments
        for azimuthal_index in range(azimuthal_segments):
            following = (azimuthal_index + 1) % azimuthal_segments
            triangles.extend(
                ([upper + azimuthal_index, lower + azimuthal_index, lower + following],
                 [upper + azimuthal_index, lower + following, upper + following])
            )
    last = 1 + (polar_segments - 2) * azimuthal_segments
    for azimuthal_index in range(azimuthal_segments):
        following = (azimuthal_index + 1) % azimuthal_segments
        triangles.append([last + azimuthal_index, south, last + following])
    return np.asarray(vertices), np.asarray(triangles, dtype=np.uint64)


def _fiber(node: dict[str, Any]) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any], list[int]]:
    segments = node["radialSegments"]
    vertices: list[list[float]] = []
    for path_index, point in enumerate(node["points"]):
        frame = node["frames"][path_index]
        radius = node["radii"][path_index]
        for radial_index in range(segments):
            angle = 2 * math.pi * radial_index / segments
            vertices.append(
                [
                    point[axis]
                    + radius * math.cos(angle) * frame["normal"][axis]
                    + radius * math.sin(angle) * frame["binormal"][axis]
                    for axis in range(3)
                ]
            )
    start_center = len(vertices)
    vertices.append(list(node["points"][0]))
    end_center = len(vertices)
    vertices.append(list(node["points"][-1]))
    triangles: list[list[int]] = []
    surface_indices: list[int] = []
    for radial_index in range(segments):
        following = (radial_index + 1) % segments
        triangles.append([start_center, following, radial_index])
        surface_indices.append(0)
        end_start = (len(node["points"]) - 1) * segments
        triangles.append([end_center, end_start + radial_index, end_start + following])
        surface_indices.append(2)
    for path_index in range(len(node["points"]) - 1):
        lower = path_index * segments
        upper = lower + segments
        for radial_index in range(segments):
            following = (radial_index + 1) % segments
            triangles.extend(
                ([lower + radial_index, lower + following, upper + following],
                 [lower + radial_index, upper + following, upper + radial_index])
            )
            surface_indices.extend((1, 1))
    return np.asarray(vertices), np.asarray(triangles, dtype=np.uint64), surface_indices


def _direct_shell(node: dict[str, Any]) -> tuple[dict[str, Any], np.ndarray[Any, Any]] | None:
    matrix = np.eye(4, dtype=np.float64)
    current = node
    while current.get("kind") in {"transform", "instance"}:
        matrix = matrix @ np.asarray(current["matrix"], dtype=np.float64).reshape(4, 4)
        current = current["child"]
    return (current, matrix) if current.get("kind") == "shell" else None


def _shell_boundary_data(
    child: _CompiledGeometry,
    offsets: tuple[float, ...],
    context: manifold.ExecutionContext,
) -> _ShellBoundaryData:
    del context
    output = child.solid.to_mesh64()
    vertices = np.asarray(output.vert_properties, dtype=np.float64)[:, :3]
    world_center = (np.min(vertices, axis=0) + np.max(vertices, axis=0)) / 2
    vertices = vertices - world_center
    triangles = np.asarray(output.tri_verts, dtype=np.int64)
    adjacent: list[list[tuple[np.ndarray[Any, Any], float]]] = [[] for _ in vertices]
    normals = np.empty((len(triangles), 3), dtype=np.float64)
    for triangle_index, triangle in enumerate(triangles):
        points = vertices[triangle]
        normal = np.cross(points[1] - points[0], points[2] - points[0])
        length = float(np.linalg.norm(normal))
        normal /= length
        normals[triangle_index] = normal
        for corner, vertex_index in enumerate(triangle):
            before = points[(corner + 2) % 3] - points[corner]
            after = points[(corner + 1) % 3] - points[corner]
            cosine = float(np.dot(before, after) / (np.linalg.norm(before) * np.linalg.norm(after)))
            weight = math.acos(max(-1.0, min(1.0, cosine)))
            adjacent[int(vertex_index)].append((normal, weight))
    displacements = np.empty_like(vertices)
    for vertex_index, faces in enumerate(adjacent):
        coefficients = np.asarray([math.sqrt(weight) * normal for normal, weight in faces])
        target = np.asarray([math.sqrt(weight) for _normal, weight in faces])
        displacement, _residuals, _rank, _singular_values = np.linalg.lstsq(
            coefficients,
            target,
            rcond=1e-12,
        )
        displacements[vertex_index] = displacement
    boundaries = {offset: vertices + offset * displacements for offset in offsets}
    return _ShellBoundaryData(world_center, triangles, displacements, boundaries)


def _shell(
    child: _CompiledGeometry,
    shell_node_id: str,
    inner_offset: float,
    outer_offset: float,
    context: manifold.ExecutionContext,
) -> _CompiledGeometry:
    data = _shell_boundary_data(child, (inner_offset, outer_offset), context)
    inner = data.boundaries[inner_offset]
    outer = data.boundaries[outer_offset]
    shell_vertices = np.concatenate((inner, outer), axis=0)
    shell_triangles = np.concatenate(
        (data.triangles[:, ::-1], data.triangles + len(inner)),
        axis=0,
    )
    face_ids = np.concatenate(
        (
            np.zeros(len(data.triangles), dtype=np.uint64),
            np.ones(len(data.triangles), dtype=np.uint64),
        )
    )
    mesh = manifold.Mesh64(
        np.ascontiguousarray(shell_vertices),
        np.ascontiguousarray(shell_triangles, dtype=np.uint64),
        face_id=face_ids,
    )
    solid = context.from_mesh(mesh).translate(tuple(float(item) for item in data.world_center))
    shell_output = solid.to_mesh64()
    original_id = int(shell_output.run_original_id[0])
    provenance = {
        (original_id, 0): (shell_node_id, 0),
        (original_id, 1): (shell_node_id, 1),
    }
    return _CompiledGeometry(solid, provenance)


def _length_scale(unit: str, reference_unit: str, root_id: str) -> float:
    return convert_ucum_value(1, unit, reference_unit, f"geometry root {root_id!r}.lengthUnit") - convert_ucum_value(
        0,
        unit,
        reference_unit,
        f"geometry root {root_id!r}.lengthUnit",
    )


def _immutable(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _immutable(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_immutable(item) for item in value)
    return value
