"""Native surface distortion and stress integrals for small-strain solids."""

import numpy as np

from app.methods.fields.box_grid import clip_box_polygon
from app.methods.fields.tetrahedral import clipped_tetrahedron
from app.kernel.api.units import convert_ucum_value

from ..thermal import thermal_stress_at
from .fields import _tet_stress
from .sections import _tet_plane_triangles


def reference_plane_pieces(model, grid, origin, normal):
    cells = np.asarray([element.nodes for element in model.elements])
    distances = (model.points - origin) @ normal
    # Same signed ownership/tolerance as _tet_plane_triangles; reject distant
    # cells before constructing their plane intersection and clipping polygon.
    tolerance = 64 * np.finfo(float).eps * max(1., np.max(np.ptp(model.points, axis=0)))
    selected = np.flatnonzero((distances[cells].min(axis=1) <= tolerance)
                              & (distances[cells].max(axis=1) >= -tolerance))
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
                yield index, piece, np.column_stack((1 - local.sum(axis=1), local))


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
    for index, triangle, barycentric in reference_plane_pieces(model, grid, origin, normal):
        area = np.linalg.norm(np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])) / 2
        if area == 0:
            continue
        design = np.column_stack(((triangle - origin) @ basis / length, np.ones(3)))
        displacement = barycentric @ solution.displacement[model.elements[index].nodes, :3] @ normal
        mass = area / 12 * (np.ones((3, 3)) + np.eye(3))
        gram += design.T @ mass @ design
        load += design.T @ mass @ displacement
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
    cells = np.asarray([element.nodes for element in model.elements])
    coordinates = local_points[cells]
    selected = np.flatnonzero(np.all(coordinates.max(axis=1) > 0, axis=1)
                              & np.all(coordinates.min(axis=1) < 1, axis=1))
    if model.thermal_strain is not None:
        inside = np.all((coordinates[selected] >= 0) & (coordinates[selected] <= 1), axis=(1, 2))
        contained, selected = selected[inside], selected[~inside]
        volumes = np.abs(np.linalg.det(coordinates[contained, 1:] - coordinates[contained, :1])) / 6
        eigenstrain = model.thermal_strain[contained]
        change = eigenstrain - eigenstrain.mean(axis=1)[:, None]
        elasticity = np.asarray([model.elements[index].material["C"][:, :3].sum(axis=1) for index in contained]).reshape(-1, 6)
        stress = np.asarray(solution.stresses)[contained].mean(axis=1)[:, None, :] - change[:, :, None] * elasticity[:, None, :]
        stress[:, :, :3] -= stress[:, :, :3].mean(axis=2)[:, :, None]
        weighted = stress * np.sqrt([1.5, 1.5, 1.5, 3., 3., 3.])
        squared_integral = np.sum(volumes / 20 * (np.sum(weighted.sum(axis=1)**2, axis=1) + np.sum(weighted**2, axis=(1, 2))))
        volume_sum = volumes.sum()
    for index in selected:
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
