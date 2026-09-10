from __future__ import annotations

import asyncio
import json
import math
from dataclasses import dataclass
from decimal import Decimal
from types import MappingProxyType
from typing import Any, Awaitable, Callable, Sequence

import manifold3d as manifold
import numpy as np

from app.methods.geometry.models import (
    ShellLayerGeometry,
    TriangleProvenance,
    TriangularMesh,
    VolumeMesh,
)
from app.methods.mesh.models import VolumeMeshingProfile
from app.methods.mesh.tetrahedral import (
    SurfaceDescriptor,
    generate_tetrahedral_mesh,
    triangulate_planar_domains,
    triangulate_planar_patch,
    validate_volume_meshing_request,
)
from app.kernel.api import ContentKey, ValueCache
from app.kernel.api.units import convert_ucum_value

_BACKEND_VERSION = "manifold3d-3.5.1"
_MESHING_PROFILE = "canonical-v1"
_VOLUME_BACKEND_VERSION = "netgen-mesher-6.2.2606"
_VOLUME_MESHING_PROFILE = "tetrahedral-v4"


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


@dataclass(frozen=True, slots=True)
class _SurfaceOccurrence:
    region: int
    face: tuple[int, int, int]
    provenance: TriangleProvenance


@dataclass(frozen=True, slots=True)
class _PlanarPatch:
    occurrence_indices: tuple[int, ...]
    region: int
    provenance: TriangleProvenance
    boundary: frozenset[tuple[int, int]]
    normal: np.ndarray[Any, Any]


class GeometryService:
    """Run-scoped access to canonical geometry and shared triangulation."""

    def __init__(self, *, cache: ValueCache | None = None) -> None:
        self._meshes: dict[tuple[str, str, str, str, str], TriangularMesh] = {}
        self._shell_layers: dict[tuple[str, str, str, str], ShellLayerGeometry] = {}
        self._volume_meshes: dict[tuple[Any, ...], VolumeMesh] = {}
        self._cache = cache

    @property
    def cached_mesh_count(self) -> int:
        return len(self._meshes) + len(self._volume_meshes)

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
        cache_key = ContentKey.from_parts("geometry.triangular-mesh", *key)
        if self._cache is not None:
            cached = self._cache.lookup(cache_key)
            if isinstance(cached, TriangularMesh):
                cached.vertices.setflags(write=False)
                cached.triangles.setflags(write=False)
                self._meshes[key] = cached
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
        scale = _length_scale(scene["lengthUnit"], reference_length_unit)
        vertices *= scale
        vertices.setflags(write=False)
        triangles.setflags(write=False)
        result = TriangularMesh(vertices, triangles, provenance)
        if self._cache is not None:
            result = self._cache.publish(cache_key, result)
            result.vertices.setflags(write=False)
            result.triangles.setflags(write=False)
        existing = self._meshes.get(key)
        if existing is not None:
            return existing
        self._meshes[key] = result
        if progress is not None:
            await progress({"stage": "geometry", "completed": 1, "total": 1})
        return result

    async def volume_mesh(
        self,
        scene: dict[str, Any],
        root_ids: Sequence[str],
        reference_length_unit: str,
        profile: VolumeMeshingProfile,
        progress: Callable[[Any], Awaitable[None]] | None = None,
    ) -> VolumeMesh:
        if isinstance(root_ids, str):
            raise TypeError("volume mesh root_ids must be a sequence, not a string")
        region_ids = tuple(root_ids)
        if not region_ids or len(set(region_ids)) != len(region_ids):
            raise ValueError("volume mesh root ids must be non-empty and unique")
        key = (
            scene["geometryHash"],
            region_ids,
            reference_length_unit,
            _BACKEND_VERSION,
            _VOLUME_BACKEND_VERSION,
            _VOLUME_MESHING_PROFILE,
            profile,
        )
        cached = self._volume_meshes.get(key)
        if cached is not None:
            return cached
        cache_key = ContentKey.from_parts("geometry.volume-mesh", *key)
        if self._cache is not None:
            cached = self._cache.lookup(cache_key)
            if isinstance(cached, VolumeMesh):
                _freeze_volume_mesh(cached)
                self._volume_meshes[key] = cached
                return cached

        if progress is not None:
            await progress({"stage": "volume-mesh", "completed": 0, "total": 1})
        surface_meshes = [
            await self.triangular_mesh(scene, root_id, reference_length_unit)
            for root_id in region_ids
        ]
        try:
            await asyncio.to_thread(
                validate_volume_meshing_request,
                tuple((mesh.vertices, mesh.triangles) for mesh in surface_meshes),
                profile,
            )
            points, faces, markers, descriptors, provenance_by_marker = await asyncio.to_thread(
                _volume_surface,
                surface_meshes,
                profile.boundary_max_element_size,
                profile.grading,
                profile.optimization_steps,
            )
        except MemoryError as error:
            raise RuntimeError(
                "canonical boundary preparation exhausted memory; increase the mesh element sizes"
            ) from error
        generated = await asyncio.to_thread(
            generate_tetrahedral_mesh,
            points,
            faces,
            markers,
            descriptors,
            len(region_ids),
            profile,
        )
        result = VolumeMesh(
            generated.points,
            generated.cells,
            generated.boundary_faces,
            tuple(provenance_by_marker[int(marker)] for marker in generated.boundary_markers),
            region_ids,
            generated.cell_region_ids,
            generated.quality,
        )
        if self._cache is not None:
            result = self._cache.publish(cache_key, result)
            _freeze_volume_mesh(result)
        existing = self._volume_meshes.get(key)
        if existing is not None:
            return existing
        self._volume_meshes[key] = result
        if progress is not None:
            await progress({"stage": "volume-mesh", "completed": 1, "total": 1})
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
        cache_key = ContentKey.from_parts(
            "geometry.shell-layer",
            scene["geometryHash"],
            root_id,
            reference_length_unit,
            _BACKEND_VERSION,
            _MESHING_PROFILE,
        )
        if self._cache is not None:
            cached = self._cache.lookup(cache_key)
            if isinstance(cached, ShellLayerGeometry):
                for mesh in (cached.inner, cached.outer):
                    mesh.vertices.setflags(write=False)
                    mesh.triangles.setflags(write=False)
                self._shell_layers[key] = cached
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
        scale = _length_scale(scene["lengthUnit"], reference_length_unit)
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
        if self._cache is not None:
            result = self._cache.publish(cache_key, result)
            for mesh in (result.inner, result.outer):
                mesh.vertices.setflags(write=False)
                mesh.triangles.setflags(write=False)
        existing = self._shell_layers.get(key)
        if existing is not None:
            return existing
        self._shell_layers[key] = result
        if progress is not None:
            await progress({"stage": "geometry", "completed": 1, "total": 1})
        return result


def _volume_surface(
    meshes: Sequence[TriangularMesh],
    boundary_max_element_size: float = 1e100,
    grading: float = 0.3,
    optimization_steps: int = 0,
) -> tuple[
    np.ndarray[Any, Any],
    np.ndarray[Any, Any],
    np.ndarray[Any, Any],
    tuple[SurfaceDescriptor, ...],
    tuple[tuple[TriangleProvenance, ...], ...],
]:
    solids = [
        manifold.Manifold(
            manifold.Mesh64(
                np.array(mesh.vertices, dtype=np.float64, order="C", copy=True),
                np.array(mesh.triangles, dtype=np.uint64, order="C", copy=True),
                face_id=np.zeros(len(mesh.triangles), dtype=np.uint64),
            )
        )
        for mesh in meshes
    ]
    for first_index, first in enumerate(solids):
        for second in solids[first_index + 1 :]:
            intersection = manifold.Manifold.batch_boolean(
                (first, second), manifold.OpType.Intersect
            )
            if intersection.volume() > 0:
                raise ValueError("volume mesh roots must not have overlapping interiors")

    mesh_vertices = [np.asarray(mesh.vertices, dtype=np.float64) for mesh in meshes]
    if any(
        vertices.ndim != 2
        or vertices.shape[1] != 3
        or not np.all(np.isfinite(vertices))
        for vertices in mesh_vertices
    ):
        raise ValueError("canonical triangular mesh vertices must be finite with shape (N, 3)")
    coordinate_scale = max(
        1.0,
        *(float(np.max(np.abs(vertices))) for vertices in mesh_vertices if vertices.size),
    )
    tolerance = 128 * np.finfo(np.float64).eps * coordinate_scale
    points: list[list[float]] = []
    point_indices: dict[tuple[float, float, float], int] = {}
    point_buckets: dict[tuple[int, int, int], list[int]] = {}
    occurrences: list[_SurfaceOccurrence] = []
    for region, (mesh, vertices) in enumerate(zip(meshes, mesh_vertices, strict=True)):
        triangles = np.asarray(mesh.triangles, dtype=np.int64)
        if triangles.ndim != 2 or triangles.shape[1] != 3:
            raise ValueError("canonical triangular mesh faces must have shape (M, 3)")
        if triangles.shape[0] != len(mesh.triangle_provenance):
            raise ValueError("canonical triangular mesh provenance length does not match its faces")
        local_to_global = np.empty(vertices.shape[0], dtype=np.int64)
        for local_index, point in enumerate(vertices):
            point_key = tuple(float(value) for value in point)
            global_index = point_indices.get(point_key)
            if global_index is None:
                bucket = tuple(int(math.floor(value / tolerance)) for value in point_key)
                global_index = next(
                    (
                        candidate
                        for x_offset in (-1, 0, 1)
                        for y_offset in (-1, 0, 1)
                        for z_offset in (-1, 0, 1)
                        for candidate in point_buckets.get(
                            (
                                bucket[0] + x_offset,
                                bucket[1] + y_offset,
                                bucket[2] + z_offset,
                            ),
                            (),
                        )
                        if np.max(np.abs(np.asarray(points[candidate]) - point)) <= tolerance
                    ),
                    None,
                )
                if global_index is None:
                    global_index = len(points)
                    points.append(list(point_key))
                    point_buckets.setdefault(bucket, []).append(global_index)
                point_indices[point_key] = global_index
            local_to_global[local_index] = global_index

        edge_counts: dict[tuple[int, int], int] = {}
        for triangle, provenance in zip(triangles, mesh.triangle_provenance, strict=True):
            if np.any(triangle < 0) or np.any(triangle >= vertices.shape[0]):
                raise ValueError("canonical triangle references a vertex outside its mesh")
            face = tuple(int(local_to_global[int(index)]) for index in triangle)
            if len(set(face)) != 3:
                raise ValueError("canonical triangular mesh contains a degenerate face")
            for start, end in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])):
                edge = (min(start, end), max(start, end))
                edge_counts[edge] = edge_counts.get(edge, 0) + 1
            occurrences.append(_SurfaceOccurrence(region, face, provenance))
        if any(count != 2 for count in edge_counts.values()):
            raise ValueError("each canonical root must provide a closed manifold triangle surface")

    surface_rows: list[
        tuple[tuple[int, int, int], SurfaceDescriptor, tuple[TriangleProvenance, ...]]
    ] = []
    consumed: set[int] = set()
    point_array = np.asarray(points, dtype=np.float64)
    planar_patches = _planar_patches(occurrences, point_array)
    edge_insertions: dict[tuple[int, int], list[int]] = {}
    overlap_graph = _planar_overlap_graph(
        planar_patches,
        occurrences,
        point_array,
        tolerance,
    )
    pending_patches = set(overlap_graph)
    while pending_patches:
        component: set[int] = set()
        pending = [next(iter(pending_patches))]
        while pending:
            patch_index = pending.pop()
            if patch_index in component:
                continue
            component.add(patch_index)
            pending.extend(overlap_graph.get(patch_index, ()) - component)
        pending_patches.difference_update(component)
        component_patches = [planar_patches[index] for index in sorted(component)]
        rows, inserted = _arrange_planar_patches(
            component_patches,
            points,
            point_indices,
            tolerance,
            boundary_max_element_size,
            grading,
            optimization_steps,
        )
        surface_rows.extend(rows)
        for edge, inserted_points in inserted.items():
            edge_insertions.setdefault(edge, []).extend(inserted_points)
        for patch in component_patches:
            consumed.update(patch.occurrence_indices)

    for patch in planar_patches:
        if consumed.intersection(patch.occurrence_indices):
            continue
        loops = _boundary_loops(patch.boundary)
        if len(loops) <= 1:
            continue
        rows, inserted = _remesh_planar_patch(
            patch,
            loops,
            points,
            point_indices,
            tolerance,
            boundary_max_element_size,
            grading,
            optimization_steps,
        )
        surface_rows.extend(rows)
        for edge, inserted_points in inserted.items():
            edge_insertions.setdefault(edge, []).extend(inserted_points)
        consumed.update(patch.occurrence_indices)

    if edge_insertions:
        split_rows: list[
            tuple[tuple[int, int, int], SurfaceDescriptor, tuple[TriangleProvenance, ...]]
        ] = []
        for face, descriptor, aliases in surface_rows:
            split_rows.extend(
                (child, descriptor, aliases)
                for child in _split_face_at_edge_points(
                    face, edge_insertions, points, point_indices
                )
            )
        surface_rows = split_rows

    remaining_occurrences: list[_SurfaceOccurrence] = []
    for index, occurrence in enumerate(occurrences):
        if index not in consumed:
            remaining_occurrences.extend(
                _SurfaceOccurrence(occurrence.region, face, occurrence.provenance)
                for face in _split_face_at_edge_points(
                    occurrence.face, edge_insertions, points, point_indices
                )
            )
    occurrences_by_face: dict[tuple[int, int, int], list[_SurfaceOccurrence]] = {}
    for occurrence in remaining_occurrences:
        occurrences_by_face.setdefault(tuple(sorted(occurrence.face)), []).append(occurrence)
    for shared in occurrences_by_face.values():
        if len(shared) == 1:
            occurrence = shared[0]
            surface_rows.append(
                (occurrence.face, SurfaceDescriptor(occurrence.region), (occurrence.provenance,))
            )
        elif len(shared) == 2:
            if shared[0].region == shared[1].region:
                raise ValueError("canonical root contains a duplicate surface triangle")
            if not _opposite_triangle_orientation(shared[0].face, shared[1].face):
                raise ValueError("bonded interface triangles must have opposite orientations")
            occurrence = min(shared, key=lambda item: item.region)
            other = shared[0] if shared[1] is occurrence else shared[1]
            surface_rows.append(
                (
                    occurrence.face,
                    SurfaceDescriptor(occurrence.region, other.region),
                    (occurrence.provenance, other.provenance),
                )
            )
        else:
            raise ValueError("more than two regions share the same canonical surface triangle")

    point_regions = [set() for _point in points]
    point_interface_edges: list[set[tuple[int, int]]] = [set() for _point in points]
    for face, descriptor, _aliases in surface_rows:
        face_regions = {descriptor.dominant_region}
        interface_edge: tuple[int, int] | None = None
        if descriptor.outside_region is not None:
            face_regions.add(descriptor.outside_region)
            interface_edge = (
                min(descriptor.dominant_region, descriptor.outside_region),
                max(descriptor.dominant_region, descriptor.outside_region),
            )
        for point_index in face:
            point_regions[point_index].update(face_regions)
            if interface_edge is not None:
                point_interface_edges[point_index].add(interface_edge)
    for incident_regions, interface_edges in zip(
        point_regions,
        point_interface_edges,
        strict=True,
    ):
        if len(incident_regions) <= 1:
            continue
        reachable = {min(incident_regions)}
        while True:
            expanded = reachable | {
                region
                for edge in interface_edges
                if reachable.intersection(edge)
                for region in edge
            }
            if expanded == reachable:
                break
            reachable = expanded
        if not incident_regions.issubset(reachable):
            raise ValueError(
                "volume mesh roots touch only at an edge or point without a local "
                "positive-area bonded interface"
            )

    faces: list[tuple[int, int, int]] = []
    markers: list[int] = []
    descriptors: list[SurfaceDescriptor] = []
    provenance_by_marker: list[tuple[TriangleProvenance, ...]] = []
    marker_by_description: dict[
        tuple[SurfaceDescriptor, tuple[TriangleProvenance, ...]], int
    ] = {}
    for face, descriptor, aliases in surface_rows:
        description = (descriptor, aliases)
        marker = marker_by_description.get(description)
        if marker is None:
            marker = len(descriptors)
            marker_by_description[description] = marker
            descriptors.append(descriptor)
            provenance_by_marker.append(aliases)
        faces.append(face)
        markers.append(marker)
    if not faces:
        raise ValueError("volume meshing requires a non-empty canonical boundary")
    return (
        np.asarray(points, dtype=np.float64),
        np.asarray(faces, dtype=np.int64),
        np.asarray(markers, dtype=np.int64),
        tuple(descriptors),
        tuple(provenance_by_marker),
    )


def _opposite_triangle_orientation(
    first: tuple[int, int, int],
    second: tuple[int, int, int],
) -> bool:
    positions = tuple(first.index(vertex) for vertex in second)
    inversions = sum(
        positions[left] > positions[right]
        for left in range(3)
        for right in range(left + 1, 3)
    )
    return inversions % 2 == 1


def _planar_patches(
    occurrences: Sequence[_SurfaceOccurrence],
    points: np.ndarray[Any, Any],
) -> tuple[_PlanarPatch, ...]:
    grouped: dict[tuple[int, TriangleProvenance], list[int]] = {}
    for index, occurrence in enumerate(occurrences):
        grouped.setdefault((occurrence.region, occurrence.provenance), []).append(index)
    scale = max(1.0, float(np.max(np.abs(points))))
    tolerance = 128 * np.finfo(np.float64).eps * scale
    patches: list[_PlanarPatch] = []
    for (region, provenance), group in grouped.items():
        edge_occurrences: dict[tuple[int, int], list[int]] = {}
        for index in group:
            a, b, c = occurrences[index].face
            for start, end in ((a, b), (b, c), (c, a)):
                edge_occurrences.setdefault((min(start, end), max(start, end)), []).append(index)
        adjacent: dict[int, set[int]] = {index: set() for index in group}
        for linked in edge_occurrences.values():
            for first in linked:
                adjacent[first].update(index for index in linked if index != first)
        remaining = set(group)
        while remaining:
            component: set[int] = set()
            pending = [next(iter(remaining))]
            while pending:
                index = pending.pop()
                if index in component:
                    continue
                component.add(index)
                pending.extend(adjacent[index] - component)
            remaining.difference_update(component)
            first_face = occurrences[next(iter(component))].face
            first_points = points[np.asarray(first_face, dtype=np.int64)]
            normal = np.cross(first_points[1] - first_points[0], first_points[2] - first_points[0])
            normal_length = float(np.linalg.norm(normal))
            if normal_length == 0:
                raise ValueError("canonical triangular mesh contains a zero-area face")
            normal /= normal_length
            component_vertices = {
                vertex for index in component for vertex in occurrences[index].face
            }
            offsets = points[np.asarray(sorted(component_vertices), dtype=np.int64)] - first_points[0]
            if np.any(np.abs(offsets @ normal) > tolerance):
                continue
            boundary_counts: dict[tuple[int, int], int] = {}
            for index in component:
                a, b, c = occurrences[index].face
                for start, end in ((a, b), (b, c), (c, a)):
                    edge = (min(start, end), max(start, end))
                    boundary_counts[edge] = boundary_counts.get(edge, 0) + 1
            boundary = frozenset(edge for edge, count in boundary_counts.items() if count == 1)
            if boundary:
                patches.append(
                    _PlanarPatch(
                        tuple(sorted(component)),
                        region,
                        provenance,
                        boundary,
                        normal,
                    )
                )
    return tuple(patches)


def _patches_coplanar(
    first: _PlanarPatch,
    second: _PlanarPatch,
    occurrences: Sequence[_SurfaceOccurrence],
    points: np.ndarray[Any, Any],
    tolerance: float,
) -> bool:
    first_point = points[occurrences[first.occurrence_indices[0]].face[0]]
    second_point = points[occurrences[second.occurrence_indices[0]].face[0]]
    return (
        abs(abs(float(np.dot(first.normal, second.normal))) - 1) <= tolerance
        and abs(float(np.dot(second_point - first_point, first.normal))) <= tolerance
    )


def _boundary_loops(boundary: frozenset[tuple[int, int]]) -> tuple[tuple[int, ...], ...]:
    neighbors: dict[int, set[int]] = {}
    for start, end in boundary:
        neighbors.setdefault(start, set()).add(end)
        neighbors.setdefault(end, set()).add(start)
    if any(len(linked) != 2 for linked in neighbors.values()):
        raise ValueError("planar patch boundary must consist of closed non-branching loops")
    unused = set(boundary)
    loops: list[tuple[int, ...]] = []
    while unused:
        start, following = min(unused)
        loop = [start]
        previous, current = start, following
        unused.remove((min(previous, current), max(previous, current)))
        while current != start:
            loop.append(current)
            candidates = [
                vertex
                for vertex in neighbors[current]
                if vertex != previous
                and (min(current, vertex), max(current, vertex)) in unused
            ]
            if len(candidates) != 1:
                raise ValueError("planar patch boundary loop is not continuous")
            previous, current = current, candidates[0]
            unused.remove((min(previous, current), max(previous, current)))
        loops.append(tuple(loop))
    return tuple(loops)


def _planar_overlap_graph(
    patches: Sequence[_PlanarPatch],
    occurrences: Sequence[_SurfaceOccurrence],
    points: np.ndarray[Any, Any],
    tolerance: float,
) -> dict[int, set[int]]:
    graph: dict[int, set[int]] = {}
    buckets: dict[tuple[int, tuple[float, float, float], int], list[int]] = {}
    bounds: dict[tuple[int, int], tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]] = {}
    for patch_index, patch in enumerate(patches):
        dropped_axis = int(np.argmax(np.abs(patch.normal)))
        kept_axes = [axis for axis in range(3) if axis != dropped_axis]
        canonical_normal = patch.normal.copy()
        if canonical_normal[dropped_axis] < 0:
            canonical_normal *= -1
        normal_key = tuple(round(float(value), 12) for value in canonical_normal)
        anchor_index = min(patch.boundary)[0]
        offset = float(np.dot(canonical_normal, points[anchor_index]))
        offset_bin = int(math.floor(offset / (4 * tolerance)))
        patch_vertices = np.asarray(
            sorted({vertex for edge in patch.boundary for vertex in edge}),
            dtype=np.int64,
        )
        projected = points[patch_vertices][:, kept_axes]
        bounds[(patch_index, dropped_axis)] = (
            np.min(projected, axis=0),
            np.max(projected, axis=0),
        )
        for neighboring_bin in range(offset_bin - 1, offset_bin + 2):
            bucket_key = (dropped_axis, normal_key, neighboring_bin)
            for other_index in buckets.get(bucket_key, ()):
                other = patches[other_index]
                if patch.region == other.region or not _patches_coplanar(
                    patch,
                    other,
                    occurrences,
                    points,
                    tolerance,
                ):
                    continue
                lower, upper = bounds[(patch_index, dropped_axis)]
                other_lower, other_upper = bounds[(other_index, dropped_axis)]
                overlap = np.minimum(upper, other_upper) - np.maximum(lower, other_lower)
                if np.any(overlap <= tolerance):
                    continue
                combined_lower = np.minimum(lower, other_lower)
                combined_upper = np.maximum(upper, other_upper)
                coordinate_origin = combined_lower + (combined_upper - combined_lower) / 2
                coordinate_span = float(np.max(combined_upper - combined_lower))
                coordinate_scale = 1e6 / coordinate_span
                section = _planar_patch_cross_section(
                    patch,
                    points,
                    kept_axes,
                    coordinate_origin,
                    coordinate_scale,
                )
                other_section = _planar_patch_cross_section(
                    other,
                    points,
                    kept_axes,
                    coordinate_origin,
                    coordinate_scale,
                )
                intersection = section ^ other_section
                if (
                    not intersection.is_empty()
                    and intersection.area() > (tolerance * coordinate_scale) ** 2
                ):
                    graph.setdefault(patch_index, set()).add(other_index)
                    graph.setdefault(other_index, set()).add(patch_index)
        buckets.setdefault((dropped_axis, normal_key, offset_bin), []).append(patch_index)
    return graph


def _planar_patch_cross_section(
    patch: _PlanarPatch,
    points: np.ndarray[Any, Any],
    kept_axes: list[int],
    coordinate_origin: np.ndarray[Any, Any],
    coordinate_scale: float,
) -> manifold.CrossSection:
    loops = _boundary_loops(patch.boundary)
    polygons = [
        (points[np.asarray(loop, dtype=np.int64)][:, kept_axes] - coordinate_origin)
        * coordinate_scale
        for loop in loops
    ]
    signed_areas = [
        float(np.sum(
            polygon[:, 0] * np.roll(polygon[:, 1], -1)
            - np.roll(polygon[:, 0], -1) * polygon[:, 1]
        )) / 2
        for polygon in polygons
    ]
    outer_index = int(np.argmax(np.abs(signed_areas)))
    contours: list[np.ndarray[Any, Any]] = []
    for index, (polygon, signed_area) in enumerate(zip(polygons, signed_areas, strict=True)):
        if signed_area == 0:
            raise ValueError("planar patch boundary loop has zero area")
        wants_positive = index == outer_index
        contours.append(polygon if (signed_area > 0) == wants_positive else polygon[::-1])
    section = manifold.CrossSection(contours)
    if section.is_empty():
        raise ValueError("planar patch boundary does not enclose an area")
    return section


def _arrange_planar_patches(
    patches: Sequence[_PlanarPatch],
    points: list[list[float]],
    point_indices: dict[tuple[float, float, float], int],
    tolerance: float,
    maximum_edge_length: float,
    grading: float,
    optimization_steps: int,
) -> tuple[
    list[tuple[tuple[int, int, int], SurfaceDescriptor, tuple[TriangleProvenance, ...]]],
    dict[tuple[int, int], list[int]],
]:
    reference = patches[0]
    dropped_axis = int(np.argmax(np.abs(reference.normal)))
    kept_axes = [axis for axis in range(3) if axis != dropped_axis]
    point_array = np.asarray(points, dtype=np.float64)
    boundary_vertices = np.asarray(
        sorted({vertex for patch in patches for edge in patch.boundary for vertex in edge}),
        dtype=np.int64,
    )
    projected_boundary = point_array[boundary_vertices][:, kept_axes]
    coordinate_lower = np.min(projected_boundary, axis=0)
    coordinate_upper = np.max(projected_boundary, axis=0)
    coordinate_origin = coordinate_lower + (coordinate_upper - coordinate_lower) / 2
    coordinate_span = float(np.max(coordinate_upper - coordinate_lower))
    if coordinate_span <= tolerance:
        raise ValueError("planar patch arrangement has no resolvable extent")
    coordinate_scale = 1e6 / coordinate_span
    normalized_tolerance = tolerance * coordinate_scale
    sections = [
        _planar_patch_cross_section(
            patch,
            point_array,
            kept_axes,
            coordinate_origin,
            coordinate_scale,
        )
        for patch in patches
    ]
    atoms: list[tuple[manifold.CrossSection, frozenset[int]]] = []
    for patch_index, section in enumerate(sections):
        updated: list[tuple[manifold.CrossSection, frozenset[int]]] = []
        remainder = section
        for atom, covers in atoms:
            intersection = atom ^ section
            difference = atom - section
            if not difference.is_empty() and difference.area() > normalized_tolerance**2:
                updated.append((difference, covers))
            if not intersection.is_empty() and intersection.area() > normalized_tolerance**2:
                updated.append((intersection, covers | {patch_index}))
            remainder = remainder - atom
        if not remainder.is_empty() and remainder.area() > normalized_tolerance**2:
            updated.append((remainder, frozenset({patch_index})))
        atoms = updated

    sections_by_cover: dict[frozenset[int], list[manifold.CrossSection]] = {}
    for section, covers in atoms:
        sections_by_cover.setdefault(covers, []).append(section)
    arrangement: list[tuple[tuple[np.ndarray[Any, Any], ...], frozenset[int]]] = []
    for covers in sorted(sections_by_cover, key=lambda value: tuple(sorted(value))):
        combined = manifold.CrossSection.compose(sections_by_cover[covers])
        if combined.is_empty():
            continue
        for component in combined.decompose():
            if component.is_empty() or component.area() <= normalized_tolerance**2:
                continue
            arrangement.append(
                (
                    tuple(
                        np.asarray(contour, dtype=np.float64) / coordinate_scale
                        + coordinate_origin
                        for contour in component.to_polygons()
                    ),
                    covers,
                )
            )
    if not arrangement:
        raise ValueError("planar patch arrangement is empty")

    domain_metadata: list[
        tuple[SurfaceDescriptor, tuple[TriangleProvenance, ...], np.ndarray[Any, Any]]
    ] = []
    for _contours, covers in arrangement:
        covered = [patches[index] for index in sorted(covers)]
        if len(covered) > 2:
            raise ValueError("more than two regions share a planar interface area")
        if len({patch.region for patch in covered}) != len(covered):
            raise ValueError("one region contains overlapping coplanar boundary patches")
        if len(covered) == 1:
            patch = covered[0]
            domain_metadata.append(
                (SurfaceDescriptor(patch.region), (patch.provenance,), patch.normal)
            )
            continue
        dominant, outside = sorted(covered, key=lambda patch: patch.region)
        if float(np.dot(dominant.normal, outside.normal)) >= 0:
            raise ValueError("bonded planar interface patches must have opposite orientations")
        domain_metadata.append(
            (
                SurfaceDescriptor(dominant.region, outside.region),
                (dominant.provenance, outside.provenance),
                dominant.normal,
            )
        )

    boundary_loops = tuple(
        loop
        for patch in patches
        for loop in _boundary_loops(patch.boundary)
    )
    required_points = np.concatenate(
        tuple(point_array[np.asarray(loop, dtype=np.int64)][:, kept_axes] for loop in boundary_loops),
        axis=0,
    )
    planar_points, triangles, domains = triangulate_planar_domains(
        tuple(contours for contours, _covers in arrangement),
        required_points,
        tolerance,
        maximum_edge_length,
        grading,
        optimization_steps,
    )
    generated_indices, inserted = _embed_planar_points(
        planar_points,
        boundary_loops,
        kept_axes,
        dropped_axis,
        reference.normal,
        points,
        point_indices,
        tolerance,
    )
    updated_points = np.asarray(points, dtype=np.float64)
    rows: list[
        tuple[tuple[int, int, int], SurfaceDescriptor, tuple[TriangleProvenance, ...]]
    ] = []
    for triangle, domain in zip(triangles, domains, strict=True):
        descriptor, aliases, target_normal = domain_metadata[int(domain)]
        face = tuple(generated_indices[int(index)] for index in triangle)
        face_points = updated_points[np.asarray(face, dtype=np.int64)]
        if float(np.dot(
            np.cross(face_points[1] - face_points[0], face_points[2] - face_points[0]),
            target_normal,
        )) < 0:
            face = (face[0], face[2], face[1])
        rows.append((face, descriptor, aliases))
    return rows, {edge: sorted(set(indices)) for edge, indices in inserted.items()}


def _remesh_planar_patch(
    patch: _PlanarPatch,
    loops: tuple[tuple[int, ...], ...],
    points: list[list[float]],
    point_indices: dict[tuple[float, float, float], int],
    tolerance: float,
    maximum_edge_length: float,
    grading: float,
    optimization_steps: int,
) -> tuple[
    list[tuple[tuple[int, int, int], SurfaceDescriptor, tuple[TriangleProvenance, ...]]],
    dict[tuple[int, int], list[int]],
]:
    dropped_axis = int(np.argmax(np.abs(patch.normal)))
    kept_axes = [axis for axis in range(3) if axis != dropped_axis]
    point_array = np.asarray(points, dtype=np.float64)
    projected = tuple(
        point_array[np.asarray(loop, dtype=np.int64)][:, kept_axes]
        for loop in loops
    )
    areas = tuple(
        abs(float(np.sum(
            polygon[:, 0] * np.roll(polygon[:, 1], -1)
            - np.roll(polygon[:, 0], -1) * polygon[:, 1]
        )))
        for polygon in projected
    )
    outer_index = int(np.argmax(areas))
    boundary_loops = (
        loops[outer_index],
        *(loop for index, loop in enumerate(loops) if index != outer_index),
    )
    outer = projected[outer_index]
    holes = tuple(
        polygon for index, polygon in enumerate(projected) if index != outer_index
    )
    planar_points, triangles = triangulate_planar_patch(
        outer,
        holes,
        maximum_edge_length,
        grading,
        optimization_steps,
    )
    generated_indices, inserted = _embed_planar_points(
        planar_points,
        boundary_loops,
        kept_axes,
        dropped_axis,
        patch.normal,
        points,
        point_indices,
        tolerance,
    )
    updated_points = np.asarray(points, dtype=np.float64)
    rows: list[
        tuple[tuple[int, int, int], SurfaceDescriptor, tuple[TriangleProvenance, ...]]
    ] = []
    for triangle in triangles:
        face = tuple(generated_indices[int(index)] for index in triangle)
        face_points = updated_points[np.asarray(face, dtype=np.int64)]
        if float(np.dot(
            np.cross(face_points[1] - face_points[0], face_points[2] - face_points[0]),
            patch.normal,
        )) < 0:
            face = (face[0], face[2], face[1])
        rows.append((face, SurfaceDescriptor(patch.region), (patch.provenance,)))
    return rows, {edge: sorted(set(indices)) for edge, indices in inserted.items()}


def _embed_planar_points(
    planar_points: np.ndarray[Any, Any],
    boundary_loops: tuple[tuple[int, ...], ...],
    kept_axes: list[int],
    dropped_axis: int,
    normal: np.ndarray[Any, Any],
    points: list[list[float]],
    point_indices: dict[tuple[float, float, float], int],
    tolerance: float,
) -> tuple[list[int], dict[tuple[int, int], list[int]]]:
    projected_vertices = {
        tuple(float(value) for value in np.asarray(points[index])[kept_axes]): index
        for loop in boundary_loops
        for index in loop
    }
    anchor = np.asarray(points[boundary_loops[0][0]], dtype=np.float64)
    generated_indices: list[int] = []
    inserted: dict[tuple[int, int], list[int]] = {}
    for planar_point in planar_points:
        planar_key = tuple(float(value) for value in planar_point)
        point_index = projected_vertices.get(planar_key)
        if point_index is None:
            point_index = next(
                (
                    index
                    for projected_point, index in projected_vertices.items()
                    if np.linalg.norm(np.asarray(projected_point) - planar_point) <= tolerance
                ),
                None,
            )
        if point_index is None:
            point = np.empty(3, dtype=np.float64)
            point[kept_axes] = planar_point
            point[dropped_axis] = anchor[dropped_axis] - float(
                np.dot(normal[kept_axes], planar_point - anchor[kept_axes])
                / normal[dropped_axis]
            )
            point_key = tuple(float(value) for value in point)
            point_index = point_indices.get(point_key)
            if point_index is None:
                point_index = len(points)
                points.append(list(point_key))
                point_indices[point_key] = point_index
        generated_indices.append(point_index)
        for loop in boundary_loops:
            for start, end in zip(loop, (*loop[1:], loop[0]), strict=True):
                start_point = np.asarray(points[start], dtype=np.float64)[kept_axes]
                end_point = np.asarray(points[end], dtype=np.float64)[kept_axes]
                edge = end_point - start_point
                length_squared = float(np.dot(edge, edge))
                if length_squared == 0:
                    continue
                parameter = float(np.dot(planar_point - start_point, edge) / length_squared)
                if tolerance < parameter < 1 - tolerance:
                    projection = start_point + parameter * edge
                    if float(np.linalg.norm(planar_point - projection)) <= tolerance:
                        inserted.setdefault((min(start, end), max(start, end)), []).append(
                            point_index
                        )
    return generated_indices, inserted


def _split_face_at_edge_points(
    face: tuple[int, int, int],
    insertions: dict[tuple[int, int], list[int]],
    points: list[list[float]],
    point_indices: dict[tuple[float, float, float], int],
) -> tuple[tuple[int, int, int], ...]:
    boundary: list[int] = []
    for start, end in zip(face, (*face[1:], face[0]), strict=True):
        boundary.append(start)
        edge = (min(start, end), max(start, end))
        direction = np.asarray(points[end]) - np.asarray(points[start])
        length_squared = float(np.dot(direction, direction))
        edge_points = sorted(
            set(insertions.get(edge, ())),
            key=lambda index: float(
                np.dot(np.asarray(points[index]) - np.asarray(points[start]), direction)
                / length_squared
            ),
        )
        boundary.extend(index for index in edge_points if index not in (start, end))
    if len(boundary) == 3:
        return (face,)
    centroid = np.mean(np.asarray([points[index] for index in face]), axis=0)
    centroid_key = tuple(float(value) for value in centroid)
    centroid_index = point_indices.get(centroid_key)
    if centroid_index is None:
        centroid_index = len(points)
        points.append(list(centroid_key))
        point_indices[centroid_key] = centroid_index
    return tuple(
        (centroid_index, start, boundary[(index + 1) % len(boundary)])
        for index, start in enumerate(boundary)
    )


def _freeze_volume_mesh(mesh: VolumeMesh) -> None:
    for array in (
        mesh.points,
        mesh.cells,
        mesh.boundary_faces,
        mesh.cell_region_ids,
        mesh.quality.cell_volumes,
        mesh.quality.mean_ratios,
    ):
        array.setflags(write=False)


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
    face_ids = np.asarray(output.face_id, dtype=np.uint64)
    for run, original_id in enumerate(output.run_original_id):
        for triangle_index in range(int(run_index[run]), int(run_index[run + 1])):
            provenance = provenance_by_face[(int(original_id), int(face_ids[triangle_index]))]
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


def _length_scale(unit: str, reference_unit: str) -> float:
    return convert_ucum_value(1, unit, reference_unit) - convert_ucum_value(
        0,
        unit,
        reference_unit,
    )


def _immutable(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _immutable(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_immutable(item) for item in value)
    return value
