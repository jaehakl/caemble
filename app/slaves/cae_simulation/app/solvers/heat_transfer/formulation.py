"""Steady Fourier heat balance using consistent volume and surface integration."""

from dataclasses import dataclass

import numpy as np

from app.methods.coupling.assembly import transfer_assembly_cell_field
from app.methods.finite_element.scalar import solve_scalar, surface_integrals
from app.methods.linalg.compensated import physical_residual
from .interfaces import interface_matrix


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
    stored_energy: float = 0.
    storage_power: float = 0.


def solve_heat(setup, source, tolerance, cancellation=None, *, backend="direct", previous=None,
               time_step=None, reference_temperature=0.):
    domain = setup.mesh.field_domain
    elements = setup.mesh.elements
    heating = np.zeros(len(elements.cells)) if source is None else transfer_assembly_cell_field(
        source, domain, quantity_kind="PowerDensity", unit="W.m-3")
    matrix = elements.diffusion(setup.conductivity)
    if setup.interfaces:
        matrix += interface_matrix(domain.points, setup.interfaces)
    load = elements.volume_load(heating)
    # Solve temperature differences to avoid cancellation of the large absolute
    # Kelvin offset in thin, highly conducting domains and late cooling steps.
    reference = next(iter(setup.fixed.values()), None)
    if reference is None:
        reference = next((p["ambientTemperature"] for method, _, p in setup.boundaries
                          if method == "heat.convection"),
                         float(np.mean(previous)) if previous is not None else reference_temperature)
    robin_boundaries = []
    flux_power = 0.0
    for method, faces, p in setup.boundaries:
        if method == "heat.flux":
            _, boundary_load, areas = surface_integrals(domain.points, faces, flux=-p["outwardFlux"])
            load += boundary_load
            flux_power += float(areas.sum() * p["outwardFlux"])
        elif method == "heat.convection":
            exchange, boundary_load, areas = surface_integrals(domain.points, faces, p["coefficient"],
                p["coefficient"] * (p["ambientTemperature"] - reference))
            matrix += exchange
            load += boundary_load
            robin_boundaries.append((faces, areas, p))
    anchored = np.unique(np.concatenate([faces.ravel() for faces, _, _ in robin_boundaries])) if robin_boundaries else ()
    stored_energy = storage_power = 0.
    if previous is None:
        relative_temperature, reaction, residual, roundoff = solve_scalar(matrix, load,
            {node: value - reference for node, value in setup.fixed.items()}, tolerance=tolerance,
            cancellation=cancellation, anchored_nodes=anchored, backend=backend, compensated=True)
    else:
        previous = np.asarray(previous)
        if setup.volumetric_capacity is None or time_step is None or not np.isfinite(time_step) or time_step <= 0:
            raise ValueError("transient Heat requires positive capacity and time step")
        if previous.shape != (elements.node_count,) or not np.isfinite(previous).all():
            raise ValueError("previous temperature must cover every thermal degree of freedom")
        capacity = elements.capacity(setup.volumetric_capacity)
        relative_previous = previous - reference
        increment, reaction, residual, roundoff = solve_scalar(matrix + capacity / time_step,
            physical_residual(matrix, relative_previous, load),
            {node: value - previous[node] for node, value in setup.fixed.items()}, tolerance=tolerance,
            cancellation=cancellation, anchored_nodes=np.arange(elements.node_count), backend=backend, compensated=True)
        weights = np.asarray(capacity.sum(axis=0)).ravel()
        storage_power = float((weights @ increment + weights @ roundoff) / time_step)
        relative_temperature = relative_previous + increment
        added = relative_temperature - relative_previous
        roundoff += (relative_previous - (relative_temperature - added)) + (increment - added)
        stored_energy = float(weights @ (relative_temperature + (reference - reference_temperature)) + weights @ roundoff)
    temperature = reference + relative_temperature
    fixed_power = -float(reaction[list(setup.fixed)].sum())
    robin_power = sum(float(np.sum(areas * p["coefficient"] * (relative_temperature[faces].mean(axis=1) + roundoff[faces].mean(axis=1) + (reference - p["ambientTemperature"]))))
                      for faces, areas, p in robin_boundaries)
    heat_flux = -np.einsum("eij,ej->ei", setup.conductivity, elements.gradient(relative_temperature) + elements.gradient(roundoff))
    return HeatSolution(setup, temperature, heat_flux, float(heating @ elements.volumes),
                        fixed_power + flux_power + robin_power, fixed_power, flux_power, robin_power, residual,
                        stored_energy, storage_power)
