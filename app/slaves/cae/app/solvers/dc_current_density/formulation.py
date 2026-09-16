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


def solve_dc(setup, tolerance, cancellation=None):
    elements = setup.mesh.elements
    matrix = elements.diffusion(setup.conductivity)
    potential, reaction, residual = solve_scalar(matrix, np.zeros(elements.node_count), setup.fixed,
                                                tolerance=tolerance, cancellation=cancellation)
    gradient = elements.gradient(potential)
    current = -np.einsum("eij,ej->ei", setup.conductivity, gradient)
    heating = -np.einsum("ei,ei->e", gradient, current)
    currents = {name: float(reaction[terminal["nodes"]].sum()) for name, terminal in setup.terminals.items()}
    power = sum(setup.terminals[name]["voltage"] * current for name, current in currents.items())
    dissipation = float(heating @ elements.volumes)
    return DcSolution(setup, potential, current, heating, currents, power, dissipation, residual)
