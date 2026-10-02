"""Native surface distortion and stress integrals for small-strain solids."""

import numpy as np
from ..solid_elements import SolidElements

from app.methods.fields.box_grid import clip_box_polygon
from app.methods.fields.tetrahedral import clipped_tetrahedron
from app.kernel.api.units import convert_ucum_value

from ..thermal import thermal_stress_at
from .fields import _tet_stress
from .sections import _tet_plane_triangles


def reference_plane_batches(model, grid, origin, normal):
    cells = model.elements.cells if isinstance(model.elements, SolidElements) else np.asarray([element.nodes for element in model.elements])
    distances = (model.points - origin) @ normal
    # Same signed ownership/tolerance as _tet_plane_triangles; reject distant
    # cells before constructing their plane intersection and clipping polygon.
    tolerance = 64 * np.finfo(float).eps * max(1., np.max(np.ptp(model.points, axis=0)))
    remaining = []
    for start in range(0, len(cells), 32768):
        block = cells[start:start + 32768]
        signed = distances[block]
        selected = np.flatnonzero((signed.min(axis=1) <= tolerance) & (signed.max(axis=1) >= -tolerance))
        reference = model.points[block[selected]]
        local_tolerance = 64 * np.finfo(float).eps * np.maximum(1., np.linalg.norm(reference - reference.mean(axis=1)[:, None], axis=2).max(axis=1))
        on_plane = np.abs(signed[selected]) <= local_tolerance[:, None]
        owned_face = (on_plane.sum(axis=1) == 3) & np.any(signed[selected] < -local_tolerance[:, None], axis=1)
        candidates = np.flatnonzero(owned_face)
        face_nodes = block[selected[candidates]][on_plane[candidates]].reshape(-1, 3)
        triangles = model.points[face_nodes]
        local = grid.local_points(triangles)
        contained = np.all((local >= 0) & (local <= np.asarray(grid.geometry["size"])), axis=(1, 2))
        candidates, triangles = candidates[contained], triangles[contained]
        if len(candidates):
            barycentric = np.broadcast_to(np.eye(4), (len(candidates), 4, 4))[on_plane[candidates]].reshape(-1, 3, 4)
            yield selected[candidates] + start, triangles, barycentric
        remaining.append(np.delete(selected, candidates) + start)
    selected = np.concatenate(remaining)
    for index in selected:
        element = model.elements[index]
        reference = model.points[element.nodes]
        triangles = _tet_plane_triangles(reference, np.zeros((4, 3)), origin, normal)
        if not triangles:
            continue
        inverse = np.linalg.inv((reference[1:] - reference[0]).T)
        for triangle in triangles:
            polygon = clip_box_polygon(triangle, grid)
            for corner in range(1, len(polygon) - 1):
                piece = polygon[[0, corner, corner + 1]]
                local = (piece - reference[0]) @ inverse.T
                yield np.array([index]), piece[None], np.column_stack((1 - local.sum(axis=1), local))[None]


def reference_plane_pieces(model, grid, origin, normal):
    for indices, triangles, barycentric in reference_plane_batches(model, grid, origin, normal):
        yield from zip(indices, triangles, barycentric, strict=True)


def surface_displacement_metrics(model, solution, grid, parameters):
    origin, normal = np.asarray(parameters["origin"], dtype=float), np.asarray(parameters["normal"], dtype=float)
    if not np.isfinite(normal).all() or np.linalg.norm(normal) == 0:
        raise ValueError("surface observation normal must be nonzero and finite")
    normal = normal / np.linalg.norm(normal)
    first = np.cross(normal, np.eye(3)[np.argmin(np.abs(normal))])
    first /= np.linalg.norm(first)
    basis = np.column_stack((first, np.cross(normal, first)))
    length = np.max(grid.geometry["size"]) * convert_ucum_value(1, grid.geometry["lengthUnit"], "m")
    gram, load, samples = np.zeros((3, 3)), np.zeros(3), []
    cells = model.elements.cells if isinstance(model.elements, SolidElements) else np.asarray([element.nodes for element in model.elements])
    for indices, triangles, barycentric in reference_plane_batches(model, grid, origin, normal):
        area = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1) / 2
        design = np.concatenate(((triangles - origin) @ basis / length, np.ones((*triangles.shape[:2], 1))), axis=2)
        displacement = np.einsum("eij,ej->ei", barycentric, solution.displacement[cells[indices], :3] @ normal)
        mass = area[:, None, None] / 12 * (np.ones((3, 3)) + np.eye(3))
        gram += np.einsum("eia,eij,ejb->ab", design, mass, design)
        load += np.einsum("eia,eij,ej->a", design, mass, displacement)
        samples.append((design, displacement))
    if not samples:
        return 0., 0.
    fitted = np.linalg.solve(gram, load)
    residuals = np.concatenate([displacement - design @ fitted for design, displacement in samples])
    maximum = max(np.max(np.abs(displacement)) for _, displacement in samples)
    return float(maximum), float(np.ptp(residuals))


def rms_von_mises_stress(model, solution, grid):
    """Exactly integrate the squared affine stress over the Box/material intersection."""
    local_points = grid.local_points(model.points, "m") / np.asarray(grid.geometry["size"])
    volume_sum = squared_integral = 0.
    cells = model.elements.cells if isinstance(model.elements, SolidElements) else np.asarray([element.nodes for element in model.elements])
    boundary_chunks = []
    for start in range(0, len(cells), 32768):
        coordinates = local_points[cells[start:start + 32768]]
        selected = np.flatnonzero(np.all(coordinates.max(axis=1) > 0, axis=1)
                                  & np.all(coordinates.min(axis=1) < 1, axis=1))
        if model.thermal_strain is not None:
            inside = np.all((coordinates[selected] >= 0) & (coordinates[selected] <= 1), axis=(1, 2))
            contained, selected = selected[inside], selected[~inside]
            volumes = np.abs(np.linalg.det(coordinates[contained, 1:] - coordinates[contained, :1])) / 6
            contained += start
            eigenstrain = model.thermal_strain[contained]
            change = eigenstrain - eigenstrain.mean(axis=1)[:, None]
            elasticity = (np.asarray([material["C"][:, :3].sum(axis=1) for material in model.elements.materials])[model.elements.material_indices[contained]]
                          if isinstance(model.elements, SolidElements)
                          else np.asarray([model.elements[index].material["C"][:, :3].sum(axis=1) for index in contained]).reshape(-1, 6))
            stress = np.asarray(solution.stresses)[contained].mean(axis=1)[:, None, :] - change[:, :, None] * elasticity[:, None, :]
            stress[:, :, :3] -= stress[:, :, :3].mean(axis=2)[:, :, None]
            weighted = stress * np.sqrt([1.5, 1.5, 1.5, 3., 3., 3.])
            squared_integral += np.sum(volumes / 20 * (np.sum(weighted.sum(axis=1)**2, axis=1) + np.sum(weighted**2, axis=(1, 2))))
            volume_sum += volumes.sum()
        boundary_chunks.append(selected + start)
    for index in np.concatenate(boundary_chunks):
        element = model.elements[index]
        vertices = local_points[element.nodes]
        if np.all((vertices >= 0) & (vertices <= 1)):
            pieces = [vertices]
        else:
            polygons = clipped_tetrahedron(vertices)
            if not polygons:
                continue
            center = np.concatenate(polygons).mean(axis=0)
            pieces = [np.asarray([center, polygon[0], polygon[corner], polygon[corner + 1]])
                      for polygon in polygons for corner in range(1, len(polygon) - 1)]
        inverse = np.linalg.inv((vertices[1:] - vertices[0]).T)
        for piece in pieces:
            volume = abs(np.linalg.det(piece[1:] - piece[0])) / 6
            if volume == 0:
                continue
            local = (piece - vertices[0]) @ inverse.T
            barycentric = np.column_stack((1 - local.sum(axis=1), local))
            if model.thermal_strain is not None:
                stress = thermal_stress_at(model, solution, index, barycentric)
            else:
                tensor = _tet_stress(model, solution, index)
                stress = np.tile(tensor[(0, 1, 2, 0, 1, 0), (0, 1, 2, 1, 2, 2)], (4, 1))
            deviator = stress.copy()
            deviator[:, :3] -= stress[:, :3].mean(axis=1)[:, None]
            weighted = deviator * np.sqrt([1.5, 1.5, 1.5, 3., 3., 3.])
            squared_integral += volume / 20 * (np.sum(weighted.sum(axis=0)**2) + np.sum(weighted**2))
            volume_sum += volume
    return float(np.sqrt(max(squared_integral / volume_sum, 0.))) if volume_sum else 0.


def thermal_section_resultant(model, solution, grid, parameters):
    """Integrate affine thermal stress, including its first moment, on a reference cut."""
    origin = np.asarray(parameters["origin"], dtype=float)
    normal = np.asarray(parameters["normal"], dtype=float)
    normal = normal / np.linalg.norm(normal)
    reference_point = np.asarray(parameters["referencePoint"], dtype=float)
    force, moment = np.zeros(3), np.zeros(3)
    quadrature = np.full((3, 3), 1 / 6) + np.eye(3) / 2
    for index, triangle, barycentric in reference_plane_pieces(model, grid, origin, normal):
        area = np.linalg.norm(np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])) / 2
        values = thermal_stress_at(model, solution, index, quadrature @ barycentric)
        stresses = values[:, [[0, 3, 5], [3, 1, 4], [5, 4, 2]]]
        traction = stresses @ normal * (area / 3)
        force += traction.sum(axis=0)
        moment += np.cross(quadrature @ triangle - reference_point, traction).sum(axis=0)
    return force, moment
