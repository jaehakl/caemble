"""MINI static equilibrium: separate u/q/bubble residuals and accepted states."""

import numpy as np
from scipy import sparse

from app.methods.continuum.hyperelastic import InvalidDeformationError

from ..loads import follower_pressure, update_follower_display
from ..mixed_solid import condense_bubble, mini_response, prepare_mini
from ..numerics import solve_linear
from ..state import initial_solution


def prepare_mixed(model, order=5):
    cells = np.asarray([element.nodes for element in model.elements])
    data = [prepare_mini(model.points[element.nodes], element.material, order) for element in model.elements]
    prepared = {key: np.asarray([item[key] for item in data]) for key in data[0]}
    dofs = np.concatenate(((6 * cells[..., None] + np.arange(3)).reshape(-1, 12), model.size + cells), axis=1)
    force = model.force.ravel().copy()
    gravity = prepared["bodyWeights"][..., None] * model.gravity
    np.add.at(force, dofs[:, :12].ravel(), gravity[:, :4].ravel())
    return {**prepared, "cells": cells, "dofs": dofs, "external": force, "bubbleExternal": gravity[:, 4]}


def mixed_assembly(model, prepared, displacement, q, bubble, factor, *, tangent=True):
    size = model.size + len(model.points)
    raw, condensed = np.zeros(size), np.zeros(size)
    matrices, recoveries, bubble_residual, stresses = [], [], [], []
    energies = np.zeros(3)
    # Bound temporary fourth-order tensors without coupling work to output grids.
    for start in range(0, len(model.elements), 128):
        stop = min(start + 128, len(model.elements))
        cells, dofs = prepared["cells"][start:stop], prepared["dofs"][start:stop]
        batch = {key: prepared[key][start:stop] for key in ("displacementGradients", "weights", "shape")}
        residual, matrix, energy, stress = mini_response(displacement[cells, :3], q[cells], bubble[start:stop], model.elements[0].material, batch, tangent=tangent)
        residual[:, 16:] -= factor * prepared["bubbleExternal"][start:stop]
        np.add.at(raw, dofs.ravel(), residual[:, :16].ravel())
        bubble_residual.extend(residual[:, 16:])
        if tangent:
            reduced, matrix, recovery = condense_bubble(residual, matrix)
            np.add.at(condensed, dofs.ravel(), reduced.ravel())
            matrices.extend(matrix)
            recoveries.extend(recovery)
        energies += energy.sum(axis=0)
        stresses.extend(stress)
    pressure_force, pressure_tangent = follower_pressure(model, displacement, tangent=tangent)
    external = factor * (prepared["external"] + pressure_force)
    raw[:model.size] -= external
    condensed[:model.size] -= external
    matrix = None
    if tangent:
        dofs = prepared["dofs"]
        matrix = sparse.csr_matrix((np.asarray(matrices).ravel(), (np.repeat(dofs, 16, axis=1).ravel(), np.tile(dofs, (1, 16)).ravel())), shape=(size, size))
        pressure_tangent.resize((size, size))
        matrix -= factor * pressure_tangent
    return {"residual": raw, "condensed": condensed, "tangent": matrix, "recovery": np.asarray(recoveries),
            "bubbleResidual": np.asarray(bubble_residual), "energies": energies, "stresses": stresses}


def mixed_static_analysis(model, tolerance=1e-8, max_iterations=30, cancellation=None):
    prepared = prepare_mixed(model)
    solution = initial_solution(model)
    solution.auxiliary_pressure = np.zeros(len(model.points))
    solution.bubble = np.zeros((len(model.elements), 3))
    free_u = np.setdiff1d(model.active, model.fixed)
    free = np.r_[free_u, model.size + np.arange(len(model.points))]
    volume = prepared["referenceVolume"].sum()
    length = np.cbrt(volume)
    force_scale = max(model.elements[0].material["shear"] * length**2, np.linalg.norm(prepared["external"]))
    factor, increment = 0., .25

    def block_residual(response):
        return np.array([np.linalg.norm(response["residual"][free_u]) / force_scale,
                         np.linalg.norm(response["residual"][model.size:]) / volume,
                         np.linalg.norm(response["bubbleResidual"]) / force_scale])

    while factor < 1 - 1e-12:
        target = min(1., factor + increment)
        displacement = solution.displacement.copy()
        q, bubble = solution.auxiliary_pressure.copy(), solution.bubble.copy()
        for dof, value in model.prescribed.items():
            displacement.ravel()[dof] = target * value
        converged = False
        for iteration in range(max_iterations):
            if cancellation is not None:
                cancellation.raise_if_cancelled()
            try:
                response = mixed_assembly(model, prepared, displacement, q, bubble, target)
            except InvalidDeformationError:
                break
            norms = block_residual(response)
            if np.max(norms) <= tolerance:
                converged = True
                break
            correction = np.zeros(model.size + len(model.points))
            correction[free] = solve_linear(response["tangent"][free][:, free], -response["condensed"][free])
            recovery = response["recovery"]
            db = -np.einsum("eij,ej->ei", recovery[:, :, :16], correction[prepared["dofs"]]) - recovery[:, :, 16]
            for reduction in range(12):
                alpha = .5**reduction
                candidate_u = displacement + alpha * correction[:model.size].reshape(-1, 6)
                candidate_q, candidate_b = q + alpha * correction[model.size:], bubble + alpha * db
                try:
                    trial = mixed_assembly(model, prepared, candidate_u, candidate_q, candidate_b, target, tangent=False)
                except InvalidDeformationError:
                    continue
                if np.sum(block_residual(trial)**2) <= (1 - 1e-4 * alpha) * np.sum(norms**2):
                    displacement, q, bubble = candidate_u, candidate_q, candidate_b
                    break
            else:
                break
        if not converged:
            increment /= 2
            if increment < 1e-6:
                raise ValueError("mixed equilibrium did not converge after load-step reduction")
            continue
        solution.displacement, solution.auxiliary_pressure, solution.bubble = displacement, q, bubble
        solution.iterations += iteration + 1
        factor, increment = target, min(2 * increment, 1 - target)
    solution.reaction.ravel()[model.fixed] = response["residual"][model.fixed]
    solution.residual = float(np.max(block_residual(response)))
    solution.strain_energy, solution.equilibrium_energy = map(float, response["energies"][1:])
    solution.stresses = [stress[:, (0, 1, 2, 0, 1, 0), (0, 1, 2, 1, 2, 2)] for stress in response["stresses"]]
    update_follower_display(model, solution.displacement)
    return solution
