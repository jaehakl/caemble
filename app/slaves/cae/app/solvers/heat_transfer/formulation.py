"""Steady Fourier heat balance using consistent volume and surface integration."""

from dataclasses import dataclass

import numpy as np

from app.methods.coupling.assembly import transfer_assembly_cell_field
from app.methods.finite_element.scalar import solve_scalar, surface_integrals


@dataclass(frozen=True)
class HeatSolution:
    setup: object
    temperature: np.ndarray
    heat_flux: np.ndarray
    source_power: float
    outward_power: float
    fixed_outward_power: float
    flux_outward_power: float
    robin_outward_power: float
    relative_residual: float


def solve_heat(setup, source, tolerance, cancellation=None):
    domain = setup.mesh.field_domain
    elements = setup.mesh.elements
    heating = np.zeros(len(elements.cells)) if source is None else transfer_assembly_cell_field(
        source, domain, quantity_kind="PowerDensity", unit="W.m-3")
    matrix = elements.diffusion(setup.conductivity)
    load = elements.volume_load(heating)
    robin_boundaries = []
    flux_power = 0.0
    for method, faces, p in setup.boundaries:
        if method == "heat.flux":
            _, boundary_load, areas = surface_integrals(domain.points, faces, flux=-p["outwardFlux"])
            load += boundary_load
            flux_power += float(areas.sum() * p["outwardFlux"])
        elif method == "heat.convection":
            exchange, boundary_load, areas = surface_integrals(domain.points, faces, p["coefficient"], p["coefficient"] * p["ambientTemperature"])
            matrix += exchange
            load += boundary_load
            robin_boundaries.append((faces, areas, p))
    anchored = np.unique(np.concatenate([faces.ravel() for faces, _, _ in robin_boundaries])) if robin_boundaries else ()
    temperature, reaction, residual = solve_scalar(matrix, load, setup.fixed, tolerance=tolerance,
                                                  cancellation=cancellation, anchored_nodes=anchored)
    fixed_power = -float(reaction[list(setup.fixed)].sum())
    robin_power = sum(float(np.sum(areas * p["coefficient"] * (temperature[faces].mean(axis=1) - p["ambientTemperature"])))
                      for faces, areas, p in robin_boundaries)
    heat_flux = -np.einsum("eij,ej->ei", setup.conductivity, elements.gradient(temperature))
    return HeatSolution(setup, temperature, heat_flux, float(heating @ elements.volumes),
                        fixed_power + flux_power + robin_power, fixed_power, flux_power, robin_power, residual)
