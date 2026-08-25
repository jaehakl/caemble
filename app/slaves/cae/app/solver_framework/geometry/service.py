from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Awaitable, Callable

import manifold3d as manifold
import numpy as np

from app.errors import CaeError
from app.solver_framework.geometry.complexity import (
    MAX_BOOLEAN_WORK,
    MAX_TRIANGLES,
    enforce_boolean_work_limit,
    enforce_triangle_limit,
)
from app.solver_framework.geometry.models import TriangleProvenance, TriangularMesh
from app.solver_framework.units import convert_ucum_value

_BACKEND_VERSION = "manifold3d-3.5.1"
_MESHING_PROFILE = "canonical-v1"


@dataclass(frozen=True, slots=True)
class _CompiledGeometry:
    solid: manifold.Manifold
    provenance: dict[tuple[int, int], tuple[str, str]]


class GeometryService:
    """Run-scoped access to canonical geometry and shared triangulation."""

    def __init__(self) -> None:
        self._meshes: dict[tuple[str, str, str, str, str], TriangularMesh] = {}
        self._cached_triangles = 0

    @property
    def cached_mesh_count(self) -> int:
        return len(self._meshes)

    def scene(self, scene: dict[str, Any]) -> MappingProxyType[str, Any]:
        return _immutable(scene)

    def root(self, scene: dict[str, Any], root_id: str) -> MappingProxyType[str, Any]:
        matches = [root for root in scene["roots"] if root["id"] == root_id]
        if len(matches) != 1:
            raise CaeError("invalid_geometry", f"Canonical Geometry root {root_id!r} is missing")
        return _immutable(matches[0])

    def geometry_group(self, scene: dict[str, Any], name: str) -> MappingProxyType[str, Any]:
        matches = [group for group in scene["geometryGroups"] if group["name"] == name]
        if len(matches) != 1:
            raise CaeError("invalid_task", f"geometry group {name!r} must occur exactly once")
        return _immutable(matches[0])

    def surface_group(self, scene: dict[str, Any], name: str) -> MappingProxyType[str, Any]:
        matches = [group for group in scene["surfaceGroups"] if group["name"] == name]
        if len(matches) != 1:
            raise CaeError("invalid_task", f"surface group {name!r} must occur exactly once")
        return _immutable(matches[0])

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
        roots = [root for root in scene["roots"] if root["id"] == root_id]
        if len(roots) != 1:
            raise CaeError("invalid_geometry", f"Canonical Geometry root {root_id!r} is missing")
        enforce_triangle_limit(roots[0]["node"], f"geometry root {root_id!r}")
        scene_boolean_work = 0
        for root in scene["roots"]:
            scene_boolean_work = min(
                MAX_BOOLEAN_WORK + 1,
                scene_boolean_work
                + enforce_boolean_work_limit(root["node"], f"geometry root {root['id']!r}"),
            )
        if scene_boolean_work > MAX_BOOLEAN_WORK:
            raise CaeError(
                "resource_limit",
                f"Canonical Geometry scene exceeds the estimated Boolean work limit of {MAX_BOOLEAN_WORK}",
            )
        if progress is not None:
            await progress({"stage": "geometry", "completed": 0, "total": 1})
        await asyncio.sleep(0)
        context = manifold.ExecutionContext()
        try:
            compiled = _compile_node(roots[0]["node"], context)
            _check_solid(compiled.solid, context, f"geometry root {root_id!r}")
            actual_triangles = compiled.solid.num_tri()
            if self._cached_triangles + actual_triangles > MAX_TRIANGLES:
                raise CaeError(
                    "resource_limit",
                    f"Geometry mesh cache may contain at most {MAX_TRIANGLES} triangles",
                )
            output = compiled.solid.to_mesh64()
            vertices = np.asarray(output.vert_properties, dtype=np.float64)[:, :3].copy()
            triangles = np.asarray(output.tri_verts, dtype=np.int64).copy()
            if triangles.shape[0] != actual_triangles:
                raise CaeError("invalid_geometry", f"geometry root {root_id!r} changed triangle count during extraction")
            provenance = _output_provenance(output, compiled.provenance, root_id)
        except CaeError:
            raise
        except Exception as exc:
            raise CaeError("invalid_geometry", f"Manifold could not evaluate geometry root {root_id!r}") from exc
        if triangles.shape[0] == 0 or triangles.shape[0] > MAX_TRIANGLES:
            code = "resource_limit" if triangles.shape[0] > MAX_TRIANGLES else "invalid_geometry"
            raise CaeError(code, f"geometry root {root_id!r} produced {triangles.shape[0]} triangles")
        scale = _length_scale(scene["lengthUnit"], reference_length_unit, root_id)
        vertices *= scale
        if not np.all(np.isfinite(vertices)):
            raise CaeError("invalid_geometry", f"geometry root {root_id!r} produced non-finite vertices")
        vertices.setflags(write=False)
        triangles.setflags(write=False)
        result = TriangularMesh(vertices, triangles, provenance)
        existing = self._meshes.get(key)
        if existing is not None:
            return existing
        self._meshes[key] = result
        self._cached_triangles += triangles.shape[0]
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
            vertices, triangles, face_keys = _curved_edge_cylinder(parameters)
            return _from_indexed(vertices, triangles, face_keys, node["nodeId"], context)
        else:
            vertices, triangles = _curved_surface_sphere(parameters)
            return _from_indexed(
                vertices,
                triangles,
                ["Outer"] * triangles.shape[0],
                node["nodeId"],
                context,
            )
        return _primitive(solid, node["nodeId"], primitive, parameters, context)
    if kind == "fiber":
        vertices, triangles, face_keys = _fiber(node)
        return _from_indexed(vertices, triangles, face_keys, node["nodeId"], context)
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
            item: semantic
            for child in children
            for item, semantic in child.provenance.items()
        }
        return _CompiledGeometry(solid, provenance)
    child = _compile_node(node["child"], context)
    return _shell(child, node["nodeId"], node["innerOffset"], node["outerOffset"], context)


def _primitive(
    solid: manifold.Manifold,
    node_id: str,
    primitive: str,
    parameters: dict[str, Any],
    context: manifold.ExecutionContext,
) -> _CompiledGeometry:
    solid = solid.as_original()
    _check_solid(solid, context, f"{primitive} {node_id!r}")
    output = solid.to_mesh64()
    vertices = np.asarray(output.vert_properties, dtype=np.float64)[:, :3]
    triangles = np.asarray(output.tri_verts, dtype=np.int64)
    face_ids = np.asarray(output.face_id, dtype=np.uint64)
    original_id = int(output.run_original_id[0])
    result: dict[tuple[int, int], tuple[str, str]] = {}
    for index, triangle in enumerate(triangles):
        if primitive in {"sphere", "curvedSurfaceSphere"}:
            face_key = "Outer"
        else:
            points = vertices[triangle]
            normal = np.cross(points[1] - points[0], points[2] - points[0])
            normal /= np.linalg.norm(normal)
            if primitive == "box":
                axis = int(np.argmax(np.abs(normal)))
                face_key = (
                    ("-X", "+X") if axis == 0 else ("-Y", "+Y") if axis == 1 else ("Bottom", "Top")
                )[int(normal[axis] > 0)]
            else:
                height = abs(parameters["height"])
                tolerance = min(max(height * 1e-10, 1e-12), height / 4)
                if np.all(np.abs(points[:, 2] + height / 2) <= tolerance):
                    face_key = "Bottom"
                elif np.all(np.abs(points[:, 2] - height / 2) <= tolerance):
                    face_key = "Top"
                else:
                    face_key = "Side"
        key = (original_id, int(face_ids[index]))
        previous = result.setdefault(key, (node_id, face_key))
        if previous != (node_id, face_key):
            raise CaeError("invalid_geometry", f"{primitive} {node_id!r} has ambiguous surface provenance")
    return _CompiledGeometry(solid, result)


def _from_indexed(
    vertices: np.ndarray[Any, Any],
    triangles: np.ndarray[Any, Any],
    face_keys: list[str],
    node_id: str,
    context: manifold.ExecutionContext,
) -> _CompiledGeometry:
    with np.errstate(over="ignore", invalid="ignore"):
        span = float(np.max(np.ptp(vertices, axis=0)))
    minimum_edge = math.inf
    for start in range(0, len(triangles), 65_536):
        points = vertices[triangles[start : start + 65_536]]
        with np.errstate(over="ignore", invalid="ignore"):
            edge_lengths = np.linalg.norm(points - np.roll(points, -1, axis=1), axis=2)
        nonzero_edges = edge_lengths[edge_lengths > 0]
        if len(nonzero_edges):
            minimum_edge = min(minimum_edge, float(np.min(nonzero_edges)))
    if not math.isfinite(span) or not math.isfinite(minimum_edge) or span * 2**-23 >= minimum_edge:
        raise CaeError(
            "invalid_geometry",
            f"geometry node {node_id!r} exceeds the Float32 indexed-mesh precision envelope",
        )

    semantics: dict[str, int] = {}
    face_ids = np.empty(len(face_keys), dtype=np.uint64)
    for index, face_key in enumerate(face_keys):
        face_ids[index] = semantics.setdefault(face_key, len(semantics))
    mesh = manifold.Mesh64(
        np.ascontiguousarray(vertices, dtype=np.float64),
        np.ascontiguousarray(triangles, dtype=np.uint64),
        face_id=face_ids,
    )
    solid = context.from_mesh(mesh)
    _check_solid(solid, context, f"geometry node {node_id!r}")
    output = solid.to_mesh64()
    if len(output.tri_verts) < len(triangles):
        raise CaeError(
            "invalid_geometry",
            f"geometry node {node_id!r} lost indexed-mesh triangles in Manifold",
        )
    original_id = int(output.run_original_id[0])
    return _CompiledGeometry(
        solid,
        {(original_id, face_id): (node_id, face_key) for face_key, face_id in semantics.items()},
    )


def _check_solid(solid: manifold.Manifold, context: manifold.ExecutionContext, label: str) -> None:
    evaluated = solid.with_context(context)
    status = evaluated.status()
    if status != manifold.Error.NoError:
        raise CaeError("invalid_geometry", f"{label} is invalid Manifold input ({status.name})")
    if evaluated.is_empty():
        raise CaeError("invalid_geometry", f"{label} produced an empty solid")
    bounds = evaluated.bounding_box()
    center = (
        -(bounds[0] + bounds[3]) / 2,
        -(bounds[1] + bounds[4]) / 2,
        -(bounds[2] + bounds[5]) / 2,
    )
    centered = evaluated.translate(center)
    volume = centered.volume()
    if not math.isfinite(volume) or volume <= 0:
        raise CaeError("invalid_geometry", f"{label} produced a non-positive volume")
    if centered.num_tri() > MAX_TRIANGLES:
        raise CaeError("resource_limit", f"{label} exceeds {MAX_TRIANGLES} triangles")


def _output_provenance(
    output: manifold.Mesh64,
    semantic_by_face: dict[tuple[int, int], tuple[str, str]],
    root_id: str,
) -> tuple[TriangleProvenance, ...]:
    triangle_count = len(output.face_id)
    result: list[TriangleProvenance | None] = [None] * triangle_count
    run_index = np.asarray(output.run_index, dtype=np.int64) // 3
    for run, original_id in enumerate(output.run_original_id):
        for triangle_index in range(int(run_index[run]), int(run_index[run + 1])):
            semantic = semantic_by_face.get((int(original_id), int(output.face_id[triangle_index])))
            if semantic is None:
                raise CaeError("invalid_geometry", "Manifold output lost semantic surface provenance")
            result[triangle_index] = TriangleProvenance(root_id, semantic[0], semantic[1])
    if any(item is None for item in result):
        raise CaeError("invalid_geometry", "Manifold output has an incomplete provenance run")
    return tuple(item for item in result if item is not None)


def _curved_edge_cylinder(
    parameters: dict[str, Any],
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any], list[str]]:
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
            if not math.isfinite(radius) or radius <= 0:
                raise CaeError("invalid_geometry", "curvedEdgeCylinder sampled a non-positive radius")
            vertices.append([radius * math.cos(theta), radius * math.sin(theta), z])
    bottom_center = len(vertices)
    vertices.append([0.0, 0.0, -height / 2])
    top_center = len(vertices)
    vertices.append([0.0, 0.0, height / 2])
    triangles: list[list[int]] = []
    face_keys: list[str] = []
    for azimuthal_index in range(azimuthal_segments):
        following = (azimuthal_index + 1) % azimuthal_segments
        triangles.append([bottom_center, following, azimuthal_index])
        face_keys.append("Bottom")
        top_start = vertical_segments * azimuthal_segments
        triangles.append([top_center, top_start + azimuthal_index, top_start + following])
        face_keys.append("Top")
    for vertical_index in range(vertical_segments):
        lower = vertical_index * azimuthal_segments
        upper = lower + azimuthal_segments
        for azimuthal_index in range(azimuthal_segments):
            following = (azimuthal_index + 1) % azimuthal_segments
            triangles.extend(
                ([lower + azimuthal_index, lower + following, upper + following],
                 [lower + azimuthal_index, upper + following, upper + azimuthal_index])
            )
            face_keys.extend(("Side", "Side"))
    return np.asarray(vertices), np.asarray(triangles, dtype=np.uint64), face_keys


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
        if not math.isfinite(radius) or radius <= 0:
            raise CaeError("invalid_geometry", "curvedSurfaceSphere sampled a non-positive radius")
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


def _fiber(node: dict[str, Any]) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any], list[str]]:
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
    face_keys: list[str] = []
    for radial_index in range(segments):
        following = (radial_index + 1) % segments
        triangles.append([start_center, following, radial_index])
        face_keys.append("Start cap")
        end_start = (len(node["points"]) - 1) * segments
        triangles.append([end_center, end_start + radial_index, end_start + following])
        face_keys.append("End cap")
    for path_index in range(len(node["points"]) - 1):
        lower = path_index * segments
        upper = lower + segments
        for radial_index in range(segments):
            following = (radial_index + 1) % segments
            triangles.extend(
                ([lower + radial_index, lower + following, upper + following],
                 [lower + radial_index, upper + following, upper + radial_index])
            )
            face_keys.extend(("Side", "Side"))
    return np.asarray(vertices), np.asarray(triangles, dtype=np.uint64), face_keys


def _shell(
    child: _CompiledGeometry,
    shell_node_id: str,
    inner_offset: float,
    outer_offset: float,
    context: manifold.ExecutionContext,
) -> _CompiledGeometry:
    _check_solid(child.solid, context, "shell child")
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
        if not math.isfinite(length) or length <= 0:
            raise CaeError("invalid_geometry", "shell child contains a degenerate triangle")
        normal /= length
        normals[triangle_index] = normal
        for corner, vertex_index in enumerate(triangle):
            before = points[(corner + 2) % 3] - points[corner]
            after = points[(corner + 1) % 3] - points[corner]
            cosine = float(np.dot(before, after) / (np.linalg.norm(before) * np.linalg.norm(after)))
            weight = math.acos(max(-1.0, min(1.0, cosine)))
            if not math.isfinite(weight) or weight <= 0:
                raise CaeError("invalid_geometry", "shell child contains a degenerate corner")
            adjacent[int(vertex_index)].append((normal, weight))
    displacements = np.empty_like(vertices)
    for vertex_index, faces in enumerate(adjacent):
        matrix = sum((weight * np.outer(normal, normal) for normal, weight in faces), np.zeros((3, 3)))
        target = sum((weight * normal for normal, weight in faces), np.zeros(3))
        total_weight = sum(weight for _normal, weight in faces)
        average_length = float(np.linalg.norm(target))
        if average_length <= 0 or total_weight <= 0:
            raise CaeError("invalid_geometry", f"shell has no stable offset at vertex {vertex_index}")
        average = target / average_length
        regularization = total_weight * 1e-8
        matrix += np.eye(3) * regularization
        target += average * regularization
        try:
            displacements[vertex_index] = np.linalg.solve(matrix, target)
        except np.linalg.LinAlgError as exc:
            raise CaeError("invalid_geometry", f"shell has no stable offset at vertex {vertex_index}") from exc
    inner = vertices + inner_offset * displacements
    outer = vertices + outer_offset * displacements
    minimum = np.minimum(np.min(inner, axis=0), np.min(outer, axis=0))
    maximum = np.maximum(np.max(inner, axis=0), np.max(outer, axis=0))
    span = float(np.max(maximum - minimum))
    minimum_gap = float(np.min(np.max(np.abs(outer - inner), axis=1)))
    if not math.isfinite(minimum_gap) or minimum_gap <= span * 2**-23:
        raise CaeError(
            "invalid_geometry",
            f"shell {shell_node_id!r} exceeds the portable Float32 shell precision envelope",
        )
    world_magnitude = float(
        np.max(
            np.abs(
                np.concatenate(
                    (
                        world_center + minimum,
                        world_center + maximum,
                    )
                )
            )
        )
    )
    if minimum_gap <= max(span, world_magnitude) * 2**-52:
        raise CaeError(
            "invalid_geometry",
            f"shell {shell_node_id!r} exceeds the portable Float64 mesh precision envelope",
        )
    epsilon = max(float(np.max(np.ptp(vertices, axis=0))) * 1e-12, 1e-12) ** 2
    for offset, boundary in ((inner_offset, inner), (outer_offset, outer)):
        signed = np.einsum(
            "ij,ij->i",
            np.cross(boundary[triangles[:, 1]] - boundary[triangles[:, 0]], boundary[triangles[:, 2]] - boundary[triangles[:, 0]]),
            normals,
        )
        if np.any(~np.isfinite(signed)) or np.any(signed <= epsilon):
            raise CaeError("invalid_geometry", f"shell offset {offset} creates an inverted surface")
    shell_vertices = np.concatenate((inner, outer), axis=0)
    shell_triangles = np.concatenate((triangles[:, ::-1], triangles + len(vertices)), axis=0)
    face_ids = np.concatenate(
        (
            np.zeros(len(triangles), dtype=np.uint64),
            np.ones(len(triangles), dtype=np.uint64),
        )
    )
    mesh = manifold.Mesh64(
        np.ascontiguousarray(shell_vertices),
        np.ascontiguousarray(shell_triangles, dtype=np.uint64),
        face_id=face_ids,
    )
    solid = context.from_mesh(mesh).translate(tuple(float(item) for item in world_center))
    _check_solid(solid, context, "shell")
    shell_output = solid.to_mesh64()
    original_id = int(shell_output.run_original_id[0])
    provenance = {
        (original_id, 0): (shell_node_id, "inner"),
        (original_id, 1): (shell_node_id, "outer"),
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
