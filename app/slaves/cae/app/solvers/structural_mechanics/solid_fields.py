"""Evaluate converged solid fields at reference material coordinates."""

import numpy as np

from app.methods.continuum.hyperelastic import InvalidDeformationError, neo_hookean
from app.methods.continuum.mixed_hyperelastic import mixed_neo_hookean
from app.methods.finite_element.tetrahedron import mini_shape, tetrahedron_quadrature


def evaluate_solid(model, solution, index, barycentric):
    element = model.elements[index]
    reference = model.points[element.nodes]
    gradients = np.array([[-1., -1., -1.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]) @ np.linalg.inv((reference[1:] - reference[0]).T)
    barycentric = np.asarray(barycentric)
    displacement = solution.displacement[element.nodes, :3]
    material = element.material
    if solution.bubble is not None:
        shape, derivatives = mini_shape(barycentric, gradients)
        values = np.concatenate((displacement, solution.bubble[index][None, :]))
        deformation = np.eye(3) + np.einsum("ai,...aJ->...iJ", values, derivatives)
        u = shape @ values
        q = barycentric @ solution.auxiliary_pressure[element.nodes]
        response = mixed_neo_hookean(deformation, q, material["shear"], material["lame"])
        energy, equilibrium = response.strain_energy, response.equilibrium_energy
    else:
        deformation = np.broadcast_to(np.eye(3) + displacement.T @ gradients, (*barycentric.shape[:-1], 3, 3))
        u = barycentric @ displacement
        response = neo_hookean(deformation, material["shear"], material["lame"])
        q = material["lame"] * np.log(np.linalg.det(deformation))
        energy = equilibrium = response.energy
    return {"displacement": u, "deformationGradient": deformation, "volumeRatio": np.linalg.det(deformation),
            "auxiliaryPressure": q, "firstPiolaStress": response.piola, "cauchyStress": response.cauchy,
            "meanPressure": -np.trace(response.cauchy, axis1=-2, axis2=-1) / 3,
            "strainEnergyDensity": energy, "equilibriumEnergyDensity": equilibrium}


def solid_cell_average(model, solution, index):
    barycentric, weights = tetrahedron_quadrature() if solution.bubble is not None else (np.full((1, 4), .25), np.ones(1))
    values = evaluate_solid(model, solution, index, barycentric)
    return {name: np.einsum("g,g...->...", weights / weights.sum(), value) for name, value in values.items()}


def inverse_solid(model, solution, index, current, initial):
    """Invert the interior bubble map without substituting affine coordinates."""
    reference = model.points[model.elements[index].nodes]
    inverse = np.linalg.inv((reference[1:] - reference[0]).T)
    length = np.linalg.norm(reference[1:] - reference[0], axis=1).max()
    barycentric = np.asarray(initial).copy()
    for _ in range(40):
        fields = evaluate_solid(model, solution, index, barycentric)
        residual = barycentric @ reference + fields["displacement"] - current
        norm = np.linalg.norm(residual)
        if norm <= 1e-11 * length:
            return barycentric
        correction = inverse @ np.linalg.solve(fields["deformationGradient"], residual)
        delta = np.r_[-correction.sum(), correction]
        for reduction in range(16):
            candidate = barycentric - .5**reduction * delta
            if np.min(candidate) < -1e-10:
                continue
            try:
                trial = evaluate_solid(model, solution, index, candidate)
            except InvalidDeformationError:
                continue
            if np.linalg.norm(candidate @ reference + trial["displacement"] - current) < norm:
                barycentric = candidate
                break
        else:
            break
    raise ValueError("current MINI sample could not be inverted inside its material tetrahedron")


def sample_solid(model, solution, sampler, points, field, *, current=False):
    shape = {"displacement": (3,), "cauchyStress": (3, 3)}.get(field, ())
    result = np.zeros((len(sampler.cell_indices), *shape))
    points = np.asarray(points).reshape(-1, 3)
    for index in np.unique(sampler.cell_indices[sampler.cell_indices >= 0]):
        selected = np.flatnonzero(sampler.cell_indices == index)
        barycentric = sampler.barycentric[selected]
        if current and solution.bubble is not None:
            barycentric = np.asarray([inverse_solid(model, solution, index, points[item], initial)
                                      for item, initial in zip(selected, barycentric, strict=True)])
        result[selected] = evaluate_solid(model, solution, index, barycentric)[field]
    return result.reshape((*sampler.shape, *shape))
