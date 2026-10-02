"""First-order lens transfer between mechanical reference caps, in metres.

The enclosed cylinder is a black box, not a homogeneous refracting solid.
Principal planes and pupils may lie outside it. No internal path length,
fluence, aberration, Fresnel loss or optical phase is inferred from its size.
"""
from dataclasses import dataclass, replace

import numpy as np

from app.kernel.api.world import geometry_parts, scalar_parameter, target_group
from app.methods.geometry.analytic import SurfaceRef
from .domain import surface_keys


@dataclass(frozen=True)
class ParaxialLens:
    center: np.ndarray
    rotation: np.ndarray
    length: float
    radius: float
    focal_length: float
    front_principal: float
    rear_principal: float
    entrance_pupil: float
    exit_pupil: float
    entrance_radius: float
    exit_radius: float
    transmission: float

    def transfer(self, position, direction):
        """Return exit point/direction, or None for aperture/side interception."""
        point = self.rotation.T @ (position - self.center)
        incoming = self.rotation.T @ direction
        forward = incoming[2] > 0
        sign = 1 if forward else -1
        if abs(incoming[2]) < 1e-12:
            return None
        slope = incoming[:2] / abs(incoming[2])
        first = self.front_principal if forward else -self.rear_principal
        last = -self.rear_principal if forward else self.front_principal
        pupil_in = self.entrance_pupil if forward else -self.exit_pupil
        pupil_out = self.exit_pupil if forward else -self.entrance_pupil
        radius_in = self.entrance_radius if forward else self.exit_radius
        radius_out = self.exit_radius if forward else self.entrance_radius
        height = point[:2] + first * slope
        outgoing = slope - height / self.focal_length
        exit_height = height + last * outgoing
        if (np.linalg.norm(point[:2]) > self.radius
                or np.linalg.norm(point[:2] + pupil_in * slope) > radius_in
                or np.linalg.norm(exit_height) > self.radius
                or np.linalg.norm(exit_height + pupil_out * outgoing) > radius_out):
            return None
        exit_point = self.center + self.rotation @ np.r_[exit_height, sign * self.length / 2]
        exit_direction = self.rotation @ np.r_[outgoing, sign]
        exit_direction /= np.linalg.norm(exit_direction)
        return exit_point, exit_direction

    def exit_hit(self, entry, position, direction):
        sign = 1 if np.dot(direction, self.rotation[:, 2]) > 0 else -1
        surface = SurfaceRef(entry.surface_ref.root_id, entry.surface_ref.source_node_id, 2 if sign > 0 else 0)
        error = 128 * np.finfo(float).eps * max(self.length, np.linalg.norm(position))
        return replace(entry, position=position, distance=0., normal=sign * self.rotation[:, 2],
                       surface_ref=surface, crossing_kind='exit', distance_error=error,
                       position_error=np.full(3, error))


def build_lenses(config, scene, solids):
    lenses = {}
    occupied = set()
    scattering_roots = set()
    for rule in config['boundaryConditions']:
        if rule['methodId'] == 'ray.hg-medium':
            scattering_roots.update(part['id'] for part in geometry_parts(scene, target_group(rule, 'geometry')))
        if rule['methodId'] != 'ray.paraxial-lens' and any('.surface.' in target for target in rule['target']):
            occupied.update(surface_keys(scene, target_group(rule, 'surface'), solids))
    for rule in config['boundaryConditions']:
        if rule['methodId'] != 'ray.paraxial-lens':
            continue
        parts = geometry_parts(scene, target_group(rule, 'geometry'))
        if len(parts) != 1 or parts[0]['id'] not in solids:
            raise ValueError('Paraxial lens requires one Cylinder in ray.domain')
        solid = solids[parts[0]['id']]
        if len(solid.leaves) != 1 or solid.expression.children != (0,):
            raise ValueError('Paraxial lens requires an uncut Cylinder')
        leaf = solid.leaves[0]
        if leaf.kind != 'cylinder' or leaf.parameters['radius'] != leaf.parameters['radius_2']:
            raise ValueError('Paraxial lens requires a circular Cylinder, not a taper')
        if solid.root_id in lenses or solid.root_id in scattering_roots or any(key.root_id == solid.root_id for key in occupied):
            raise ValueError('Paraxial lens cannot overlap another lens or surface/volume optical condition')
        # A nested collision solid would otherwise be silently bypassed by the transfer.
        for other in solids.values():
            if other is not solid and (solid.contains((other.minimum + other.maximum) / 2)
                                       or other.contains((solid.minimum + solid.maximum) / 2)):
                raise ValueError('Paraxial lens cannot contain or be nested in another collision solid')
        matrix = leaf.matrix[:3, :3]
        scales = np.linalg.norm(matrix, axis=0)
        rotation = matrix / scales
        if (not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-12, rtol=0)
                or not np.isclose(scales[0], scales[1], rtol=1e-12)):
            raise ValueError('Paraxial lens requires orthogonal axes and a circular aperture')
        p = {key: scalar_parameter(value) for key, value in rule['parameters'].items()}
        if (not all(np.isfinite(value) for value in p.values()) or p['focalLength'] == 0
                or min(p['entrancePupilDiameter'], p['exitPupilDiameter']) <= 0
                or not 0 <= p['transmission'] <= 1):
            raise ValueError('Paraxial lens requires finite parameters, nonzero focus, positive pupils and transmission in [0,1]')
        lenses[solid.root_id] = ParaxialLens(
            leaf.matrix[:3, 3], rotation, leaf.parameters['height'] * scales[2],
            leaf.parameters['radius'] * scales[0], p['focalLength'],
            p['frontPrincipalOffset'], p['rearPrincipalOffset'],
            p['entrancePupilOffset'], p['exitPupilOffset'],
            p['entrancePupilDiameter'] / 2, p['exitPupilDiameter'] / 2, p['transmission'])
    return lenses
