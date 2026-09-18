from __future__ import annotations

import math

import numpy as np

from app.kernel.api.world import scalar_parameter, target_group
from app.methods.rays import vector_parameter
from .domain import surface_keys


def diffracted_direction(
    direction: np.ndarray,
    normal: np.ndarray,
    groove: np.ndarray,
    wavelength: float,
    spacing: float,
    order: int,
    *,
    incident_index: float = 1.0,
    outgoing_index: float = 1.0,
    transmission: bool = False,
) -> np.ndarray | None:
    """Reflect or transmit using the tangential wave-vector grating equation.

    The authored outward normal fixes the sign of the order: positive orders
    add vacuum wavelength / spacing along groove x normal. Both refractive
    indices are real directional indices; efficiency specifies optical power.
    """
    tangent = np.cross(groove, normal)
    tangential = direction - np.dot(direction, normal) * normal
    tangential = (incident_index * tangential + order * wavelength / spacing * tangent) / outgoing_index
    normal_squared = 1.0 - float(np.dot(tangential, tangential))
    if normal_squared < -1e-14:
        return None
    sign = 1.0 if np.dot(direction, normal) < 0 else -1.0
    if transmission:
        sign = -sign
    return tangential + sign * math.sqrt(max(0.0, normal_squared)) * normal


def build_gratings(config, scene, solids):
    gratings = {}
    incompatible = {'ray.absorbing-detector', 'ray.thin-film-stack', 'ray.abg-scatter', 'ray.lambertian-scatter'}
    occupied = set()
    for rule in config['boundaryConditions']:
        if rule['methodId'] in incompatible:
            occupied.update(surface_keys(scene, target_group(rule, 'surface'), solids))
    for rule in config['boundaryConditions']:
        if rule['methodId'] != 'ray.diffraction-grating':
            continue
        parameters = rule['parameters']
        arrays = [np.asarray(parameters[name]['value'] if isinstance(parameters[name], dict) else parameters[name], dtype=float)
                  for name in ('orders', 'reflectedEfficiencies', 'transmittedEfficiencies')]
        orders, reflected, transmitted = arrays
        if (any(array.ndim != 1 or not np.all(np.isfinite(array)) for array in arrays)
                or not len(orders) or len(reflected) != len(orders) or len(transmitted) != len(orders)
                or np.any(orders != np.floor(orders)) or len(set(orders)) != len(orders)
                or np.any(reflected < 0) or np.any(transmitted < 0)
                or float(np.sum(reflected) + np.sum(transmitted)) > 1):
            raise ValueError('Grating requires distinct integer orders and matching nonnegative efficiencies with total at most one')
        spacing = scalar_parameter(parameters['spacing'])
        if not math.isfinite(spacing) or spacing <= 0:
            raise ValueError('Grating spacing must be positive')
        groove = vector_parameter(parameters['grooveDirection'], 'grating groove direction')
        keys = surface_keys(scene, target_group(rule, 'surface'), solids)
        if len(keys) != 1:
            raise ValueError('Grating requires one surface in ray.domain')
        key = next(iter(keys))
        if key in occupied or key in gratings:
            raise ValueError('Grating surface cannot overlap another grating, detector, thin film or surface scattering')
        patches = [patch for patch in solids[key.root_id].patches if patch.reference == key]
        normals = [patch.evaluate(patch.u_range[0] + u * (patch.u_range[1] - patch.u_range[0]),
                                  patch.v_range[0] + v * (patch.v_range[1] - patch.v_range[0]))[1]
                   for patch in patches for u in (.2, .5, .8) for v in (.2, .5, .8)]
        if not normals or any(np.linalg.norm(normal - normals[0]) > 1e-6 for normal in normals):
            raise ValueError('Grating requires a planar surface with consistent normals')
        if abs(float(np.dot(groove, normals[0]))) > 1e-6:
            raise ValueError('Grating groove direction must be tangent to the surface')
        gratings[key] = parameters
    return gratings
