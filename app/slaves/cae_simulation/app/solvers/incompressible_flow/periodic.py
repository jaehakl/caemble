"""Fixed planar translation pairs and their conservative integration interfaces."""

import numpy as np

from app.methods.coupling.polygons import intersect_coplanar_triangles, polygon_area_centroid
from app.methods.finite_volume.tetrahedral import replace_fv_interfaces


def split_gravity(mesh, gravity):
    """Only the component orthogonal to every period admits periodic hydrostatics."""
    gravity = np.asarray(gravity, dtype=float)
    if not len(mesh.periodic_vectors):
        return gravity.copy(), np.zeros(3)
    directions = mesh.periodic_vectors / np.linalg.norm(mesh.periodic_vectors, axis=1)[:, None]
    _, singular, basis = np.linalg.svd(directions, full_matrices=False)
    basis = basis[singular > singular[0] * max(directions.shape) * np.finfo(float).eps]
    drive = basis.T @ (basis @ gravity)
    return gravity - drive, drive


def freeze_periodic(mesh):
    if not len(mesh.periodic_vectors):
        return None
    return {"owner": mesh.owner, "neighbour": mesh.neighbour,
            "faceCenters": mesh.face_centers, "areaVectors": mesh.area_vectors,
            "ownerFaces": mesh.interface_owner_faces, "neighbourFaces": mesh.interface_neighbour_faces,
            "neighbourShifts": mesh.neighbour_shifts, "gradientWeights": mesh.gradient_weights,
            "offsets": mesh.interface_offsets, "vertices": mesh.interface_vertices,
            "translations": mesh.periodic_vectors}


def restore_periodic(mesh, topology):
    if topology is None:
        return mesh
    return replace_fv_interfaces(mesh, owner=topology["owner"], neighbour=topology["neighbour"],
        face_centers=topology["faceCenters"], area_vectors=topology["areaVectors"],
        owner_faces=topology["ownerFaces"], neighbour_faces=topology["neighbourFaces"],
        neighbour_shifts=topology["neighbourShifts"], gradient_weights=topology["gradientWeights"],
        offsets=topology["offsets"], vertices=topology["vertices"], periodic_vectors=topology["translations"])


def boundary_patches(mesh):
    """Every physical boundary side refers to one shared integration flux."""
    boundary_index = np.full(len(mesh.faces), -1, dtype=int)
    boundary_index[mesh.boundary_face_map] = np.arange(len(mesh.boundary_face_map))
    interfaces, boundaries, signs, polygons = [], [], [], []
    for face in mesh.boundary_interface_indices:
        polygon = mesh.interface_vertices[mesh.interface_offsets[face]:mesh.interface_offsets[face + 1]]
        interfaces.append(face)
        boundaries.append(boundary_index[mesh.interface_owner_faces[face]])
        signs.append(1)
        polygons.append(polygon)
        other = mesh.interface_neighbour_faces[face]
        if other >= 0:
            interfaces.append(face)
            boundaries.append(boundary_index[other])
            signs.append(-1)
            polygons.append((polygon - mesh.neighbour_shifts[face])[::-1])
    return {"interfaceIndices": np.asarray(interfaces, dtype=np.int64),
            "boundaryIndices": np.asarray(boundaries, dtype=np.int64), "signs": np.asarray(signs, dtype=np.int8),
            "offsets": np.asarray([0, *np.cumsum([len(polygon) for polygon in polygons])], dtype=np.int64),
            "vertices": np.concatenate(polygons) if polygons else np.empty((0, 3))}


def apply_periodic(mesh, pairs, cancellation=None):
    """Replace each fully covered pair by shared planar triangle intersections.

    Pair face IDs refer to original physical triangles. Translation maps source
    points to target points; the neighbour image therefore uses its negative.
    """
    if not pairs:
        return mesh
    if len(mesh.periodic_vectors):
        raise ValueError("periodic connections must be prepared from the physical mesh once")
    assigned = np.zeros(len(mesh.faces), dtype=bool)
    translations, patches = [], []
    physical_areas = np.linalg.norm(mesh.physical_area_vectors, axis=1)
    for pair_index, pair in enumerate(pairs):
        source = np.unique(np.asarray(pair["sourceFaces"], dtype=int))
        target = np.unique(np.asarray(pair["targetFaces"], dtype=int))
        translation = np.asarray(pair["translation"], dtype=float)
        if translation.shape != (3,) or not np.all(np.isfinite(translation)) or np.linalg.norm(translation) == 0:
            raise ValueError(f"periodic pair {pair_index} requires a finite nonzero world translation")
        if not len(source) or not len(target):
            raise ValueError(f"periodic pair {pair_index} requires two nonempty surface selections")
        selected = np.r_[source, target]
        if (np.any(selected < 0) or np.any(selected >= len(mesh.faces))
                or np.any(mesh.physical_neighbour[selected] >= 0)):
            raise ValueError(f"periodic pair {pair_index} must select physical exterior triangles")
        if len(np.unique(selected)) != len(selected) or np.any(assigned[selected]):
            raise ValueError(f"periodic pair {pair_index} overlaps another selected boundary")
        assigned[selected] = True
        translations.append(translation)
        triangles_a = mesh.points[mesh.faces[source]]
        triangles_b = mesh.points[mesh.faces[target]] - translation
        origin = mesh.physical_face_centers[source[0]]
        normal = mesh.physical_area_vectors[source[0]] / physical_areas[source[0]]
        length = float(np.linalg.norm(np.ptp(np.concatenate((triangles_a, triangles_b)).reshape(-1, 3), axis=0)))
        coordinate_scale = max(float(np.max(np.abs(mesh.points[mesh.faces[selected]]))), length)
        plane_tolerance = max(1e-9 * length, 256 * np.finfo(float).eps * coordinate_scale)
        for ids, triangles, expected in ((source, triangles_a, normal), (target, triangles_b, -normal)):
            distances = np.abs((triangles - origin) @ normal)
            normals = mesh.physical_area_vectors[ids] / physical_areas[ids, None]
            errors = np.linalg.norm(normals - expected, axis=1)
            invalid = (np.max(distances, axis=1) > plane_tolerance) | (errors > 1e-8)
            if np.any(invalid):
                face = int(ids[np.flatnonzero(invalid)[0]])
                raise ValueError(f"periodic pair {pair_index} has incompatible planes, translation or outward normals "
                                 f"at physical triangle {face}, position {mesh.physical_face_centers[face].tolist()}")
        covered_a, covered_b = np.zeros(len(source)), np.zeros(len(target))
        moment_a, moment_b = np.zeros((len(source), 3)), np.zeros((len(target), 3))
        lower_b, upper_b = triangles_b.min(axis=1), triangles_b.max(axis=1)
        for index_a, triangle_a in enumerate(triangles_a):
            if cancellation is not None:
                cancellation.raise_if_cancelled()
            candidates = np.flatnonzero(np.all(upper_b >= triangle_a.min(axis=0) - plane_tolerance, axis=1)
                                       & np.all(lower_b <= triangle_a.max(axis=0) + plane_tolerance, axis=1))
            for index_b in candidates:
                polygon = intersect_coplanar_triangles(triangle_a, triangles_b[index_b], normal)
                if len(polygon) < 3:
                    continue
                area, center = polygon_area_centroid(polygon)
                roundoff_area = 128 * np.finfo(float).eps * min(physical_areas[source[index_a]], physical_areas[target[index_b]])
                if area <= roundoff_area:
                    continue
                covered_a[index_a] += area
                covered_b[index_b] += area
                moment_a[index_a] += area * (center - mesh.physical_face_centers[source[index_a]])
                moment_b[index_b] += area * (center + translation - mesh.physical_face_centers[target[index_b]])
                patches.append((source[index_a], target[index_b], translation, polygon, area, center, normal))
        for ids, covered, moments in ((source, covered_a, moment_a), (target, covered_b, moment_b)):
            areas = physical_areas[ids]
            area_error = np.abs(covered - areas) / areas
            moment_error = np.linalg.norm(moments, axis=1) / (areas * np.sqrt(areas))
            invalid = (area_error > 1e-8) | (moment_error > 1e-8)
            if np.any(invalid):
                worst = int(np.argmax(np.maximum(area_error, moment_error)))
                face = int(ids[worst])
                raise ValueError(f"periodic pair {pair_index} has incomplete or overlapping coverage at physical triangle {face}, "
                                 f"position {mesh.physical_face_centers[face].tolist()}: area {covered[worst]:.12g}/{areas[worst]:.12g}, "
                                 f"relative area error {area_error[worst]:.6g}, first-moment error {moment_error[worst]:.6g}")
    retained = np.flatnonzero(~assigned)
    owner, neighbour = list(mesh.owner[retained]), list(mesh.neighbour[retained])
    centers, vectors = list(mesh.face_centers[retained]), list(mesh.area_vectors[retained])
    owner_faces, neighbour_faces = list(retained), [-1] * len(retained)
    shifts, weights = [np.zeros(3) for _ in retained], [np.ones(2) for _ in retained]
    polygons = [mesh.points[mesh.faces[face]] for face in retained]
    for first, second, translation, polygon, area, center, normal in patches:
        owner.append(mesh.physical_owner[first])
        neighbour.append(mesh.physical_owner[second])
        centers.append(center)
        vectors.append(area * normal)
        owner_faces.append(first)
        neighbour_faces.append(second)
        shifts.append(-translation)
        weights.append([area / physical_areas[first], area / physical_areas[second]])
        polygons.append(polygon)
    return replace_fv_interfaces(mesh, owner=owner, neighbour=neighbour, face_centers=centers, area_vectors=vectors,
        owner_faces=owner_faces, neighbour_faces=neighbour_faces, neighbour_shifts=shifts, gradient_weights=weights,
        offsets=[0, *np.cumsum([len(polygon) for polygon in polygons])], vertices=np.concatenate(polygons),
        periodic_vectors=translations)
