from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import combinations
from typing import Any

import numpy as np

from app.methods.mesh.models import (
    TetrahedralMesh,
    TetrahedralMeshQuality,
    VolumeMeshingProfile,
)

_MAX_REFINEMENT_STEPS = 32
_MAX_SURFACE_POINTS = 1_500_000
_MAX_SURFACE_FACES = 2_000_000
_MAX_VOLUME_CELLS = 5_000_000


@dataclass(frozen=True, slots=True)
class SurfaceDescriptor:
    """Regions separated by a face wound outward from ``dominant_region``."""

    dominant_region: int
    outside_region: int | None = None


def validate_volume_meshing_request(
    surfaces: Sequence[tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]],
    profile: VolumeMeshingProfile,
) -> None:
    """Reject infeasible canonical-boundary resolutions before any remeshing."""

    if not surfaces:
        raise ValueError("volume meshing requires at least one canonical surface")
    total_area = 0.0
    total_volume = 0.0
    coordinate_scale = 1.0
    point_count = 0
    face_count = 0
    for raw_points, raw_faces in surfaces:
        points = np.asarray(raw_points, dtype=np.float64)
        faces = np.asarray(raw_faces, dtype=np.int64)
        if points.ndim != 2 or points.shape[1] != 3 or not np.all(np.isfinite(points)):
            raise ValueError("canonical surface points must be finite with shape (N, 3)")
        if faces.ndim != 2 or faces.shape[1] != 3 or not faces.shape[0]:
            raise ValueError("canonical surface faces must be non-empty with shape (M, 3)")
        if int(faces.min()) < 0 or int(faces.max()) >= points.shape[0]:
            raise ValueError("canonical surface connectivity references a point outside the mesh")
        point_count += points.shape[0]
        face_count += faces.shape[0]
        if point_count > _MAX_SURFACE_POINTS or face_count > _MAX_SURFACE_FACES:
            raise RuntimeError(
                "canonical boundary exceeds the internal surface-meshing resource budget"
            )
        coordinate_scale = max(coordinate_scale, float(np.max(np.abs(points))))
        triangle_points = points[faces]
        total_area += float(np.sum(np.linalg.norm(
            np.cross(
                triangle_points[:, 1] - triangle_points[:, 0],
                triangle_points[:, 2] - triangle_points[:, 0],
            ),
            axis=1,
        ))) / 2
        origin = (np.min(points, axis=0) + np.max(points, axis=0)) / 2
        shifted = triangle_points - origin
        total_volume += abs(float(np.sum(np.einsum(
            "ij,ij->i",
            shifted[:, 0],
            np.cross(shifted[:, 1], shifted[:, 2]),
        )) / 6))
    _validate_resolution_precision(coordinate_scale, profile)
    _enforce_estimated_budget(total_area, total_volume, profile)


def triangulate_planar_patch(
    outer_boundary: np.ndarray[Any, Any],
    hole_boundaries: tuple[np.ndarray[Any, Any], ...],
    maximum_edge_length: float,
    grading: float,
    optimization_steps: int,
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    """Quality-remesh one planar patch while retaining its polygonal holes."""

    points, triangles, domains = _triangulate_planar_boundaries(
        outer_boundary,
        hole_boundaries,
        split_inner_regions=False,
        maximum_edge_length=maximum_edge_length,
        grading=grading,
        optimization_steps=optimization_steps,
    )
    if np.any(domains != 0):
        raise RuntimeError("Netgen filled a hole in the planar boundary")
    return points, triangles


def triangulate_planar_domains(
    domain_contours: Sequence[tuple[np.ndarray[Any, Any], ...]],
    required_boundary_points: np.ndarray[Any, Any],
    tolerance: float,
    maximum_edge_length: float,
    grading: float,
    optimization_steps: int,
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    """Triangulate a conforming planar arrangement with one Netgen domain per atom."""

    from netgen.geom2d import SplineGeometry
    from netgen.meshing import MeshingParameters

    tolerance = float(tolerance)
    required = np.asarray(required_boundary_points, dtype=np.float64)
    if not domain_contours:
        raise ValueError("planar arrangement requires at least one domain")
    if required.ndim != 2 or required.shape[1] != 2 or not np.all(np.isfinite(required)):
        raise ValueError("required planar boundary points must be finite with shape (N, 2)")
    if not np.isfinite(tolerance) or tolerance <= 0:
        raise ValueError("planar arrangement tolerance must be finite and positive")

    contours: list[tuple[int, np.ndarray[Any, Any]]] = []
    all_candidates = [point for point in required]
    for domain, raw_contours in enumerate(domain_contours, start=1):
        if not raw_contours:
            raise ValueError("each planar arrangement domain requires at least one contour")
        for raw_contour in raw_contours:
            contour = np.asarray(raw_contour, dtype=np.float64)
            if (
                contour.ndim != 2
                or contour.shape[0] < 3
                or contour.shape[1] != 2
                or not np.all(np.isfinite(contour))
            ):
                raise ValueError("planar arrangement contours must be finite with shape (N, 2)")
            contours.append((domain, contour))
            all_candidates.extend(point for point in contour)

    candidate_bounds = np.asarray(all_candidates, dtype=np.float64)
    coordinate_lower = np.min(candidate_bounds, axis=0)
    coordinate_upper = np.max(candidate_bounds, axis=0)
    coordinate_origin = coordinate_lower + (coordinate_upper - coordinate_lower) / 2
    required = required - coordinate_origin
    local_contours: list[tuple[int, np.ndarray[Any, Any], bool]] = []
    for domain, contour in contours:
        local_contour = contour - coordinate_origin
        signed_area = float(np.sum(
            local_contour[:, 0] * np.roll(local_contour[:, 1], -1)
            - np.roll(local_contour[:, 0], -1) * local_contour[:, 1]
        )) / 2
        if abs(signed_area) <= tolerance**2:
            raise ValueError("planar arrangement contains a zero-area contour")
        # CrossSection normalizes outer contours counter-clockwise and holes
        # clockwise, so the filled domain lies to the left of both.
        local_contours.append((domain, local_contour, True))
    contours = local_contours
    all_candidates = [point - coordinate_origin for point in candidate_bounds]

    point_rows: list[list[float]] = []
    point_buckets: dict[tuple[int, int], list[int]] = {}

    def point_index(point: np.ndarray[Any, Any]) -> int:
        bucket = tuple(int(math.floor(float(value) / tolerance)) for value in point)
        existing = next(
            (
                candidate
                for x_offset in (-1, 0, 1)
                for y_offset in (-1, 0, 1)
                for candidate in point_buckets.get(
                    (bucket[0] + x_offset, bucket[1] + y_offset),
                    (),
                )
                if np.max(np.abs(np.asarray(point_rows[candidate]) - point)) <= tolerance
            ),
            None,
        )
        if existing is not None:
            return existing
        index = len(point_rows)
        point_rows.append([float(point[0]), float(point[1])])
        point_buckets.setdefault(bucket, []).append(index)
        return index

    candidate_indices = [point_index(np.asarray(point)) for point in all_candidates]
    candidate_points = np.asarray(point_rows, dtype=np.float64)
    edge_domains: dict[tuple[int, int], list[int]] = {}
    used_required: set[int] = set()
    required_indices = candidate_indices[: len(required)]
    for domain, contour, interior_on_left in contours:
        for start, end in zip(contour, np.roll(contour, -1, axis=0), strict=True):
            edge = end - start
            length_squared = float(np.dot(edge, edge))
            if length_squared <= tolerance**2:
                raise ValueError("planar arrangement contains a zero-length edge")
            parameter_tolerance = tolerance / math.sqrt(length_squared)
            along_edge: list[tuple[float, int]] = []
            for candidate, point in enumerate(candidate_points):
                parameter = float(np.dot(point - start, edge) / length_squared)
                if -parameter_tolerance <= parameter <= 1 + parameter_tolerance:
                    projection = start + min(1.0, max(0.0, parameter)) * edge
                    if float(np.linalg.norm(point - projection)) <= tolerance:
                        along_edge.append((min(1.0, max(0.0, parameter)), candidate))
            along_edge.sort()
            chain: list[int] = []
            for _parameter, candidate in along_edge:
                if not chain or candidate != chain[-1]:
                    chain.append(candidate)
            for required_index, candidate in enumerate(required_indices):
                if candidate in chain:
                    used_required.add(required_index)
            for first, second in zip(chain, chain[1:]):
                if first == second:
                    continue
                key = (min(first, second), max(first, second))
                sides = edge_domains.setdefault(key, [0, 0])
                left_side = interior_on_left
                if first > second:
                    left_side = not left_side
                side = 0 if left_side else 1
                if sides[side] not in (0, domain):
                    raise ValueError("planar arrangement has overlapping domains on one edge side")
                sides[side] = domain
    if len(used_required) != len(required):
        raise ValueError("a canonical planar boundary point was lost during arrangement")
    if any(left == right and left != 0 for left, right in edge_domains.values()):
        raise ValueError("planar arrangement has the same domain on both sides of an edge")

    geometry = SplineGeometry()
    geometry_points = [geometry.AppendPoint(*point) for point in point_rows]
    for (start, end), (left_domain, right_domain) in sorted(edge_domains.items()):
        geometry.Append(
            ["line", geometry_points[start], geometry_points[end]],
            leftdomain=left_domain,
            rightdomain=right_domain,
        )
    try:
        mesh = geometry.GenerateMesh(MeshingParameters(
            maxh=float(maximum_edge_length),
            grading=float(grading),
            optsteps2d=int(optimization_steps),
            optimize2d="" if optimization_steps == 0 else "smcm",
        ))
    except MemoryError as error:
        raise RuntimeError(
            "planar boundary arrangement exhausted memory; increase boundary_max_element_size"
        ) from error
    except RuntimeError as error:
        if "bad_alloc" not in str(error).lower() and "out of memory" not in str(error).lower():
            raise
        raise RuntimeError(
            "planar boundary arrangement exhausted memory; increase boundary_max_element_size"
        ) from error
    points = (
        np.asarray([tuple(point.p)[:2] for point in mesh.Points()], dtype=np.float64)
        + coordinate_origin
    )
    elements = list(mesh.Elements2D())
    triangles = np.asarray(
        [[vertex.nr - 1 for vertex in element.vertices] for element in elements],
        dtype=np.int64,
    )
    domains = np.asarray([int(element.index) - 1 for element in elements], dtype=np.int64)
    if (
        triangles.size == 0
        or np.any(domains < 0)
        or np.any(domains >= len(domain_contours))
    ):
        raise RuntimeError("Netgen did not preserve the planar arrangement domains")
    return points, triangles, domains


def _triangulate_planar_boundaries(
    outer_boundary: np.ndarray[Any, Any],
    inner_boundaries: tuple[np.ndarray[Any, Any], ...],
    *,
    split_inner_regions: bool,
    maximum_edge_length: float,
    grading: float,
    optimization_steps: int,
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    """Triangulate nested straight-line loops with exact domain boundaries."""

    from netgen.geom2d import SplineGeometry
    from netgen.meshing import MeshingParameters

    outer = np.asarray(outer_boundary, dtype=np.float64)
    inners = tuple(np.asarray(boundary, dtype=np.float64) for boundary in inner_boundaries)
    if outer.ndim != 2 or outer.shape[0] < 3 or outer.shape[1] != 2:
        raise ValueError("outer planar boundary must have shape (N, 2), N >= 3")
    if any(
        boundary.ndim != 2 or boundary.shape[0] < 3 or boundary.shape[1] != 2
        for boundary in inners
    ):
        raise ValueError("inner planar boundaries must have shape (N, 2), N >= 3")

    all_points = np.concatenate((outer, *inners), axis=0)
    coordinate_lower = np.min(all_points, axis=0)
    coordinate_upper = np.max(all_points, axis=0)
    coordinate_origin = coordinate_lower + (coordinate_upper - coordinate_lower) / 2
    outer = outer - coordinate_origin
    inners = tuple(boundary - coordinate_origin for boundary in inners)

    geometry = SplineGeometry()
    for loop_index, raw_loop in enumerate((outer, *inners)):
        loop = raw_loop
        signed_area = float(
            np.sum(loop[:, 0] * np.roll(loop[:, 1], -1) - np.roll(loop[:, 0], -1) * loop[:, 1])
            / 2
        )
        if signed_area == 0:
            raise ValueError("planar boundary loop has zero area")
        if signed_area < 0:
            loop = loop[::-1]
        point_ids = [geometry.AppendPoint(float(point[0]), float(point[1])) for point in loop]
        left_domain = 1 if loop_index == 0 else (loop_index + 1 if split_inner_regions else 0)
        right_domain = 0 if loop_index == 0 else 1
        for index, point_id in enumerate(point_ids):
            geometry.Append(
                ["line", point_id, point_ids[(index + 1) % len(point_ids)]],
                leftdomain=left_domain,
                rightdomain=right_domain,
            )

    try:
        mesh = geometry.GenerateMesh(MeshingParameters(
            maxh=float(maximum_edge_length),
            grading=float(grading),
            optsteps2d=int(optimization_steps),
            optimize2d="" if optimization_steps == 0 else "smcm",
        ))
    except MemoryError as error:
        raise RuntimeError(
            "planar boundary remeshing exhausted memory; increase boundary_max_element_size"
        ) from error
    except RuntimeError as error:
        if "bad_alloc" not in str(error).lower() and "out of memory" not in str(error).lower():
            raise
        raise RuntimeError(
            "planar boundary remeshing exhausted memory; increase boundary_max_element_size"
        ) from error
    points = (
        np.asarray([tuple(point.p)[:2] for point in mesh.Points()], dtype=np.float64)
        + coordinate_origin
    )
    elements = list(mesh.Elements2D())
    triangles = np.asarray(
        [[vertex.nr - 1 for vertex in element.vertices] for element in elements],
        dtype=np.int64,
    )
    domains = np.asarray([int(element.index) - 1 for element in elements], dtype=np.int64)
    maximum_domain = len(inners) if split_inner_regions else 0
    if triangles.size == 0 or np.any(domains < 0) or np.any(domains > maximum_domain):
        raise RuntimeError("Netgen did not preserve the planar interface regions")
    return points, triangles, domains


def refine_surface_mesh(
    points: np.ndarray[Any, Any],
    faces: np.ndarray[Any, Any],
    markers: np.ndarray[Any, Any],
    maximum_edge_length: float,
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    """Conformingly bisect marked triangle edges while retaining face markers."""

    refined_points = np.asarray(points, dtype=np.float64)
    refined_faces = np.asarray(faces, dtype=np.int64)
    refined_markers = np.asarray(markers, dtype=np.int64).reshape(-1)
    if refined_points.ndim != 2 or refined_points.shape[1] != 3:
        raise ValueError("surface points must have shape (N, 3)")
    if not np.all(np.isfinite(refined_points)):
        raise ValueError("surface points must be finite")
    if refined_faces.ndim != 2 or refined_faces.shape[1] != 3:
        raise ValueError("surface faces must have shape (M, 3)")
    if refined_markers.shape != (refined_faces.shape[0],):
        raise ValueError("each surface face must have one marker")
    if refined_faces.size and (
        int(refined_faces.min()) < 0 or int(refined_faces.max()) >= refined_points.shape[0]
    ):
        raise ValueError("surface connectivity references a point outside the mesh")
    maximum_edge_length = float(maximum_edge_length)
    if not np.isfinite(maximum_edge_length) or maximum_edge_length <= 0:
        raise ValueError("maximum_edge_length must be a finite positive number")
    if refined_points.shape[0] > _MAX_SURFACE_POINTS or refined_faces.shape[0] > _MAX_SURFACE_FACES:
        raise RuntimeError(
            "canonical boundary exceeds the internal surface-meshing resource budget"
        )

    refinement_step = 0
    while refined_faces.size:
        marked: set[tuple[int, int]] = set()
        for a, b, c in refined_faces:
            for start, end in ((int(a), int(b)), (int(b), int(c)), (int(c), int(a))):
                edge = (min(start, end), max(start, end))
                delta = refined_points[edge[1]] - refined_points[edge[0]]
                if float(np.dot(delta, delta)) > maximum_edge_length**2:
                    marked.add(edge)
        if not marked:
            break
        refinement_step += 1
        if refinement_step > _MAX_REFINEMENT_STEPS:
            raise RuntimeError(
                "boundary refinement exceeded its step budget; increase boundary_max_element_size"
            )
        next_point_count = refined_points.shape[0] + len(marked)
        next_face_count = sum(
            1
            + sum(
                (min(int(start), int(end)), max(int(start), int(end))) in marked
                for start, end in ((a, b), (b, c), (c, a))
            )
            for a, b, c in refined_faces
        )
        if next_point_count > _MAX_SURFACE_POINTS or next_face_count > _MAX_SURFACE_FACES:
            raise RuntimeError(
                "boundary refinement exceeds the internal surface-meshing resource budget; "
                "increase boundary_max_element_size"
            )

        try:
            point_rows = refined_points.tolist()
        except MemoryError as error:
            raise RuntimeError(
                "boundary refinement exhausted memory; increase boundary_max_element_size"
            ) from error
        midpoints: dict[tuple[int, int], int] = {}
        for edge in sorted(marked):
            midpoint = (refined_points[edge[0]] + refined_points[edge[1]]) / 2
            if np.array_equal(midpoint, refined_points[edge[0]]) or np.array_equal(
                midpoint, refined_points[edge[1]]
            ):
                raise ValueError(
                    "requested boundary resolution is below floating-point coordinate precision"
                )
            midpoints[edge] = len(point_rows)
            point_rows.append(midpoint.tolist())
        split_points = np.asarray(point_rows, dtype=np.float64)

        face_rows: list[list[int]] = []
        marker_rows: list[int] = []
        for face, marker in zip(refined_faces, refined_markers, strict=True):
            a, b, c = (int(item) for item in face)
            ab = midpoints.get((min(a, b), max(a, b)))
            bc = midpoints.get((min(b, c), max(b, c)))
            ca = midpoints.get((min(c, a), max(c, a)))
            if ab is None and bc is None and ca is None:
                children = ([a, b, c],)
            elif ab is not None and bc is None and ca is None:
                children = ([a, ab, c], [ab, b, c])
            elif ab is None and bc is not None and ca is None:
                children = ([b, bc, a], [bc, c, a])
            elif ab is None and bc is None and ca is not None:
                children = ([c, ca, b], [ca, a, b])
            elif ab is not None and bc is not None and ca is None:
                if np.linalg.norm(split_points[ab] - split_points[c]) <= np.linalg.norm(
                    split_points[a] - split_points[bc]
                ):
                    children = ([b, bc, ab], [a, ab, c], [ab, bc, c])
                else:
                    children = ([b, bc, ab], [a, ab, bc], [a, bc, c])
            elif ab is None and bc is not None and ca is not None:
                if np.linalg.norm(split_points[bc] - split_points[a]) <= np.linalg.norm(
                    split_points[b] - split_points[ca]
                ):
                    children = ([c, ca, bc], [b, bc, a], [bc, ca, a])
                else:
                    children = ([c, ca, bc], [b, bc, ca], [b, ca, a])
            elif ab is not None and bc is None and ca is not None:
                if np.linalg.norm(split_points[b] - split_points[ca]) <= np.linalg.norm(
                    split_points[ab] - split_points[c]
                ):
                    children = ([a, ab, ca], [ab, b, ca], [b, c, ca])
                else:
                    children = ([a, ab, ca], [ab, b, c], [ab, c, ca])
            elif ab is not None and bc is not None and ca is not None:
                children = (
                    [a, ab, ca],
                    [ab, b, bc],
                    [ca, bc, c],
                    [ab, bc, ca],
                )
            else:
                raise RuntimeError("surface edge refinement reached an invalid split pattern")
            face_rows.extend(children)
            marker_rows.extend([int(marker)] * len(children))
        try:
            refined_points = np.asarray(point_rows, dtype=np.float64)
            refined_faces = np.asarray(face_rows, dtype=np.int64)
            refined_markers = np.asarray(marker_rows, dtype=np.int64)
        except MemoryError as error:
            raise RuntimeError(
                "boundary refinement exhausted memory; increase boundary_max_element_size"
            ) from error

    return refined_points, refined_faces, refined_markers


def generate_tetrahedral_mesh(
    points: np.ndarray[Any, Any],
    faces: np.ndarray[Any, Any],
    markers: np.ndarray[Any, Any],
    descriptors: tuple[SurfaceDescriptor, ...],
    region_count: int,
    profile: VolumeMeshingProfile,
) -> TetrahedralMesh:
    from netgen.meshing import (
        Element2D,
        FaceDescriptor,
        Mesh,
        MeshingParameters,
        MeshPoint,
        Pnt,
    )

    if not descriptors or region_count <= 0:
        raise ValueError("volume meshing requires at least one surface and region")
    if markers.size and (int(markers.min()) < 0 or int(markers.max()) >= len(descriptors)):
        raise ValueError("surface marker has no descriptor")
    for descriptor in descriptors:
        if not 0 <= descriptor.dominant_region < region_count:
            raise ValueError("surface dominant region is outside the region table")
        if (
            descriptor.outside_region is not None
            and not 0 <= descriptor.outside_region < region_count
        ):
            raise ValueError("surface outside region is outside the region table")
        if descriptor.outside_region == descriptor.dominant_region:
            raise ValueError("a surface cannot separate a region from itself")
    _validate_meshing_budget(points, faces, markers, descriptors, region_count, profile)
    try:
        points, faces, markers = refine_surface_mesh(
            points,
            faces,
            markers,
            profile.boundary_max_element_size,
        )
    except MemoryError as error:
        raise RuntimeError(
            "boundary refinement exhausted memory; increase boundary_max_element_size"
        ) from error

    mesh = Mesh(dim=3)
    point_ids = [mesh.Add(MeshPoint(Pnt(*point))) for point in points]
    descriptor_numbers: dict[int, int] = {}
    descriptor_by_number: dict[int, SurfaceDescriptor] = {}
    marker_by_number: dict[int, int] = {}
    for marker, descriptor in enumerate(descriptors):
        descriptor_number = mesh.Add(
            FaceDescriptor(
                surfnr=marker + 1,
                domin=descriptor.dominant_region + 1,
                domout=0 if descriptor.outside_region is None else descriptor.outside_region + 1,
                bc=marker + 1,
            )
        )
        descriptor_numbers[marker] = descriptor_number
        descriptor_by_number[descriptor_number] = descriptor
        marker_by_number[descriptor_number] = marker
    for face, marker in zip(faces, markers, strict=True):
        mesh.Add(Element2D(descriptor_numbers[int(marker)], [point_ids[int(i)] for i in face]))
    for region in range(region_count):
        mesh.SetMaterial(region + 1, f"region-{region}")

    try:
        mesh.GenerateVolumeMesh(
            MeshingParameters(
                maxh=profile.max_element_size,
                grading=profile.grading,
                optsteps3d=profile.optimization_steps,
            )
        )
    except MemoryError as error:
        raise RuntimeError(
            "Netgen volume meshing exhausted memory; increase max_element_size"
        ) from error
    except RuntimeError as error:
        if "bad_alloc" not in str(error).lower() and "out of memory" not in str(error).lower():
            raise
        raise RuntimeError(
            "Netgen volume meshing exhausted memory; increase max_element_size"
        ) from error
    if int(mesh.ne) > _MAX_VOLUME_CELLS:
        raise RuntimeError(
            "generated volume mesh exceeds the internal cell resource budget; "
            "increase max_element_size"
        )
    try:
        generated_points = np.asarray([tuple(point.p) for point in mesh.Points()], dtype=np.float64)
        volume_elements = list(mesh.Elements3D())
        surface_elements = list(mesh.Elements2D())
    except MemoryError as error:
        raise RuntimeError(
            "extracting the generated volume mesh exhausted memory; increase max_element_size"
        ) from error
    if not volume_elements:
        raise RuntimeError("Netgen did not generate any tetrahedral cells")
    if any(len(element.vertices) != 4 for element in volume_elements):
        raise RuntimeError("Netgen generated a non-tetrahedral volume element")
    if any(len(element.vertices) != 3 for element in surface_elements):
        raise RuntimeError("Netgen generated a non-triangular boundary element")

    cells = np.asarray(
        [[vertex.nr - 1 for vertex in element.vertices] for element in volume_elements],
        dtype=np.int64,
    )
    cell_region_ids = np.asarray(
        [int(element.index) - 1 for element in volume_elements],
        dtype=np.int64,
    )
    if np.any(cell_region_ids < 0) or np.any(cell_region_ids >= region_count):
        raise RuntimeError("Netgen returned a tetrahedron with an unknown region")
    boundary_faces = np.asarray(
        [[vertex.nr - 1 for vertex in element.vertices] for element in surface_elements],
        dtype=np.int64,
    )
    try:
        boundary_markers = np.asarray(
            [marker_by_number[int(element.index)] for element in surface_elements],
            dtype=np.int64,
        )
    except KeyError as error:
        raise RuntimeError("Netgen returned a boundary face with an unknown descriptor") from error

    determinants = np.einsum(
        "ij,ij->i",
        np.cross(
            generated_points[cells[:, 1]] - generated_points[cells[:, 0]],
            generated_points[cells[:, 2]] - generated_points[cells[:, 0]],
        ),
        generated_points[cells[:, 3]] - generated_points[cells[:, 0]],
    )
    zero_volume = determinants == 0
    if np.any(zero_volume):
        raise RuntimeError("Netgen generated a zero-volume tetrahedron")
    reversed_cells = determinants < 0
    if np.any(reversed_cells):
        first = cells[reversed_cells, 0].copy()
        cells[reversed_cells, 0] = cells[reversed_cells, 1]
        cells[reversed_cells, 1] = first
        determinants[reversed_cells] *= -1

    face_to_cells: dict[tuple[int, int, int], list[int]] = {}
    for cell_index, cell in enumerate(cells):
        for face in combinations((int(item) for item in cell), 3):
            face_to_cells.setdefault(tuple(sorted(face)), []).append(cell_index)
    for face_index, face in enumerate(boundary_faces):
        adjacent = face_to_cells.get(tuple(sorted(int(item) for item in face)), [])
        descriptor = descriptor_by_number[int(surface_elements[face_index].index)]
        expected_regions = {descriptor.dominant_region}
        if descriptor.outside_region is not None:
            expected_regions.add(descriptor.outside_region)
        adjacent_regions = {int(cell_region_ids[index]) for index in adjacent}
        if len(adjacent) != len(expected_regions) or adjacent_regions != expected_regions:
            raise RuntimeError("Netgen boundary topology does not match its region descriptor")
        dominant_cell = next(
            index for index in adjacent if int(cell_region_ids[index]) == descriptor.dominant_region
        )
        face_points = generated_points[face]
        normal = np.cross(face_points[1] - face_points[0], face_points[2] - face_points[0])
        direction_to_dominant = np.mean(generated_points[cells[dominant_cell]], axis=0) - np.mean(
            face_points,
            axis=0,
        )
        orientation = float(np.dot(normal, direction_to_dominant))
        if orientation == 0:
            raise RuntimeError("Netgen returned a boundary face with indeterminate orientation")
        if orientation > 0:
            boundary_faces[face_index, [1, 2]] = boundary_faces[face_index, [2, 1]]

    volumes = determinants / 6
    edge_length_squared = np.zeros(len(cells), dtype=np.float64)
    for start, end in combinations(range(4), 2):
        delta = generated_points[cells[:, start]] - generated_points[cells[:, end]]
        edge_length_squared += np.einsum("ij,ij->i", delta, delta)
    mean_ratios = 12 * np.power(3 * volumes, 2 / 3) / edge_length_squared
    mean_ratios = np.minimum(mean_ratios, 1.0)
    quality = TetrahedralMeshQuality(volumes, mean_ratios)
    if quality.minimum_mean_ratio < profile.minimum_quality:
        raise RuntimeError(
            "generated tetrahedral mesh minimum mean-ratio quality "
            f"{quality.minimum_mean_ratio:.6g} is below {profile.minimum_quality:.6g}"
        )
    return TetrahedralMesh(
        generated_points,
        cells,
        boundary_faces,
        boundary_markers,
        cell_region_ids,
        quality,
    )


def _validate_meshing_budget(
    points: np.ndarray[Any, Any],
    faces: np.ndarray[Any, Any],
    markers: np.ndarray[Any, Any],
    descriptors: tuple[SurfaceDescriptor, ...],
    region_count: int,
    profile: VolumeMeshingProfile,
) -> None:
    surface_points = np.asarray(points, dtype=np.float64)
    surface_faces = np.asarray(faces, dtype=np.int64)
    surface_markers = np.asarray(markers, dtype=np.int64).reshape(-1)
    if surface_points.ndim != 2 or surface_points.shape[1] != 3:
        raise ValueError("surface points must have shape (N, 3)")
    if not np.all(np.isfinite(surface_points)):
        raise ValueError("surface points must be finite")
    if surface_faces.ndim != 2 or surface_faces.shape[1] != 3 or not surface_faces.shape[0]:
        raise ValueError("surface faces must be non-empty with shape (M, 3)")
    if surface_markers.shape != (surface_faces.shape[0],):
        raise ValueError("each surface face must have one marker")
    if (
        surface_faces.shape[0] > _MAX_SURFACE_FACES
        or surface_points.shape[0] > _MAX_SURFACE_POINTS
    ):
        raise RuntimeError(
            "canonical boundary exceeds the internal surface-meshing resource budget"
        )
    if int(surface_faces.min()) < 0 or int(surface_faces.max()) >= surface_points.shape[0]:
        raise ValueError("surface connectivity references a point outside the mesh")
    _validate_resolution_precision(max(1.0, float(np.max(np.abs(surface_points)))), profile)
    triangle_points = surface_points[surface_faces]
    triangle_areas = np.linalg.norm(
        np.cross(
            triangle_points[:, 1] - triangle_points[:, 0],
            triangle_points[:, 2] - triangle_points[:, 0],
        ),
        axis=1,
    ) / 2
    signed_region_volumes = np.zeros(region_count, dtype=np.float64)
    signed_triangle_volumes = np.einsum(
        "ij,ij->i",
        triangle_points[:, 0],
        np.cross(triangle_points[:, 1], triangle_points[:, 2]),
    ) / 6
    for marker, signed_volume in zip(surface_markers, signed_triangle_volumes, strict=True):
        descriptor = descriptors[int(marker)]
        signed_region_volumes[descriptor.dominant_region] += signed_volume
        if descriptor.outside_region is not None:
            signed_region_volumes[descriptor.outside_region] -= signed_volume
    enclosed_volume = float(np.sum(np.abs(signed_region_volumes)))
    _enforce_estimated_budget(float(np.sum(triangle_areas)), enclosed_volume, profile)


def _validate_resolution_precision(
    coordinate_scale: float,
    profile: VolumeMeshingProfile,
) -> None:
    precision_floor = 128 * np.finfo(np.float64).eps * max(1.0, coordinate_scale)
    if profile.boundary_max_element_size < precision_floor:
        raise RuntimeError(
            "boundary_max_element_size is below coordinate-precision resolution for this "
            "geometry; increase boundary_max_element_size"
        )
    if profile.max_element_size < precision_floor:
        raise RuntimeError(
            "max_element_size is below coordinate-precision resolution for this geometry; "
            "increase max_element_size"
        )


def _enforce_estimated_budget(
    surface_area: float,
    enclosed_volume: float,
    profile: VolumeMeshingProfile,
) -> None:
    if surface_area > 0:
        minimum_boundary_size = math.exp((
            math.log(surface_area)
            - math.log(_MAX_SURFACE_FACES)
            - math.log(math.sqrt(3) / 4)
        ) / 2)
        if profile.boundary_max_element_size < minimum_boundary_size:
            raise RuntimeError(
                "requested boundary resolution has an estimated minimum face count above the "
                f"internal resource budget of {_MAX_SURFACE_FACES:,}; increase "
                "boundary_max_element_size"
            )
    if enclosed_volume > 0:
        minimum_volume_size = math.exp((
            math.log(enclosed_volume)
            + math.log(6 * math.sqrt(2))
            - math.log(_MAX_VOLUME_CELLS)
        ) / 3)
        if profile.max_element_size < minimum_volume_size:
            raise RuntimeError(
                "requested volume resolution has an estimated minimum cell count above the "
                f"internal resource budget of {_MAX_VOLUME_CELLS:,}; increase max_element_size"
            )
