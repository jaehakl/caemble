"""Ohmic conduction and Joule power from the identical discrete operator."""

from dataclasses import dataclass

import numpy as np

from app.methods.finite_element.scalar import solve_scalar


@dataclass(frozen=True)
class DcSolution:
    setup: object
    potential: np.ndarray
    current_density: np.ndarray
    joule_heating: np.ndarray
    terminal_currents: dict
    input_power: float
    dissipated_power: float
    relative_residual: float


def solve_dc(setup, tolerance, cancellation=None, *, backend="direct"):
    elements = setup.mesh.elements
    matrix = elements.diffusion(setup.conductivity)
    reference = next(iter(setup.fixed.values()), 0.)
    potential, reaction, residual, roundoff = solve_scalar(matrix, np.zeros(elements.node_count),
                                                {node: voltage - reference for node, voltage in setup.fixed.items()},
                                                tolerance=tolerance, cancellation=cancellation, backend=backend, compensated=True)
    gradient = elements.gradient(potential) + elements.gradient(roundoff)
    current = -np.einsum("eij,ej->ei", setup.conductivity, gradient)
    heating = -np.einsum("ei,ei->e", gradient, current)
    currents = {name: float(reaction[terminal["nodes"]].sum()) for name, terminal in setup.terminals.items()}
    power = sum((setup.terminals[name]["voltage"] - reference) * current for name, current in currents.items())
    dissipation = float(heating @ elements.volumes)
    if abs(power - dissipation) > 1e-6 * max(abs(power), abs(dissipation), np.finfo(float).tiny):
        raise ValueError("DC terminal power and element Joule heat do not balance")
    if abs(sum(currents.values())) > 1e-6 * max(sum(abs(value) for value in currents.values()), np.finfo(float).tiny):
        raise ValueError("DC terminal currents do not balance")
    return DcSolution(setup, potential + reference, current, heating, currents, power, dissipation, residual)
