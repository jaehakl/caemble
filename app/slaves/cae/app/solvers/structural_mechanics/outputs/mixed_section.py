"""Reference-section Piola integration through the actual MINI deformation map."""

import numpy as np
from numpy.polynomial.legendre import leggauss

from app.methods.fields.box_grid import clip_box_polygon
from app.kernel.api.units import convert_ucum_value

from ..solid_fields import evaluate_solid


def mini_section_resultant(model, solution, index, triangles, normal, reference_point, grid):
    reference = model.points[model.elements[index].nodes]
    inverse = np.linalg.inv((reference[1:] - reference[0]).T)
    length = np.linalg.norm(reference[1:] - reference[0], axis=1).max()
    scale = convert_ucum_value(1, grid.geometry["lengthUnit"], "m")
    origin, size = np.asarray(grid.geometry["origin"]) * scale, np.asarray(grid.geometry["size"]) * scale
    rotation = np.asarray(grid.geometry["rotation"])
    bubble_local = solution.bubble[index] @ rotation
    nodes = model.elements[index].nodes
    # Piola stress contains the inverse of the bubble-dependent F. A higher
    # order surface rule resolves this non-polynomial section integrand.
    locations, weights = leggauss(9)
    locations, weights = (locations + 1) / 2, weights / 2
    a, b = np.meshgrid(locations, locations, indexing="ij")
    shape = np.stack((1-a, a*(1-b), a*b), axis=-1).reshape(-1, 3)
    weight = (weights[:, None] * weights[None, :] * a).ravel()

    def barycentric(points):
        natural = (points - reference[0]) @ inverse.T
        return np.column_stack((1 - natural.sum(axis=1), natural))

    def integrate(triangle):
        points = shape @ triangle
        fields = evaluate_solid(model, solution, index, barycentric(points))
        area_vector = np.cross(triangle[1]-triangle[0], triangle[2]-triangle[0])
        if area_vector @ normal < 0:
            area_vector = -area_vector
        traction = np.einsum("gij,j->gi", fields["firstPiolaStress"], area_vector)
        force = weight @ traction
        moment = weight @ np.cross(points + fields["displacement"] - reference_point, traction)
        return np.r_[force, moment]

    def visit(triangle, depth):
        bary = barycentric(triangle)
        affine = triangle + bary @ solution.displacement[nodes, :3]
        local = (affine - origin) @ rotation
        # The normalized interior bubble lies in [0,1] everywhere in a tet.
        lo = local.min(axis=0) + np.minimum(bubble_local, 0)
        hi = local.max(axis=0) + np.maximum(bubble_local, 0)
        if np.any(hi < 0) or np.any(lo > size):
            return np.zeros(6)
        if np.all(lo >= 0) and np.all(hi <= size):
            return integrate(triangle)
        current = triangle + evaluate_solid(model, solution, index, bary)["displacement"]
        mids = (triangle + np.roll(triangle, -1, axis=0)) / 2
        mid_current = mids + evaluate_solid(model, solution, index, barycentric(mids))["displacement"]
        curvature = np.max(np.linalg.norm(mid_current - (current + np.roll(current, -1, axis=0)) / 2, axis=1))
        if curvature <= length * 1e-6:
            clipped = clip_box_polygon(current, grid)
            if len(clipped) < 3:
                return np.zeros(6)
            natural = np.linalg.lstsq((current[1:] - current[0]).T, (clipped-current[0]).T, rcond=None)[0].T
            material = np.column_stack((1-natural.sum(axis=1), natural)) @ triangle
            return sum((integrate(material[[0, i, i+1]]) for i in range(1, len(material)-1)), np.zeros(6))
        if depth >= 12:
            raise ValueError("MINI section clipping did not converge on the deformed material surface")
        a, b, c = triangle
        ab, bc, ca = mids
        return sum((visit(np.asarray(piece), depth+1) for piece in ((a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca))), np.zeros(6))

    result = sum((visit(triangle, 0) for triangle in triangles), np.zeros(6))
    return result[:3], result[3:]
