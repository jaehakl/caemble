"""Passive surface-cell power observations, independent of retained ray paths."""

from dataclasses import dataclass, field
from itertools import product

import numpy as np

from app.methods.fields.box_grid import BoxGrid, pack_box_grid
from app.methods.geometry.analytic import SurfaceRef

from .domain import selectors, surface_keys


@dataclass
class DetectorTally:
    key: str
    grid: BoxGrid
    data: dict
    frequencies: np.ndarray
    surface: SurfaceRef
    values: np.ndarray = field(init=False)

    def __post_init__(self):
        self.values = np.zeros((*self.grid.shape, len(self.frequencies), 1), dtype=np.float64)

    def score_hit(self, position, power, wavelength):
        local = self.grid.local_points(np.asarray(position), 'm')
        size = np.asarray(self.grid.geometry['size'])
        # Only roundoff at a transformed boundary is snapped. Exterior hits are rejected.
        tolerance = 64 * np.finfo(float).eps * max(
            float(np.max(size)), float(np.max(np.abs(local))), float(np.max(np.abs(self.grid.geometry['origin']))))
        if abs(local[2] - size[2] / 2) > tolerance:
            return
        if np.any(local[:2] < -tolerance) or np.any(local[:2] > size[:2] + tolerance):
            return
        scaled = local[:2] / size[:2] * self.grid.shape[:2]
        nearest = np.rint(scaled)
        scaled = np.where(np.abs(scaled - nearest) <= tolerance / size[:2] * self.grid.shape[:2], nearest, scaled)
        cell = np.minimum(np.maximum(np.floor(scaled).astype(int), 0), np.asarray(self.grid.shape[:2]) - 1)
        frequency = int(np.searchsorted(self.frequencies, 299792458.0 / wavelength))
        self.values[cell[0], cell[1], 0, frequency, 0] += power

    def artifact(self):
        return pack_box_grid(self.grid, self.data, self.values, frequencies=self.frequencies)


def build_detector_tallies(config, descriptor, frequencies, scene, solids, detectors):
    definitions = {item['methodId']: item for item in descriptor['methods']['outputs']}
    absorbing = {key for detector in detectors for key in detector.surface_keys}
    tallies = []
    for rule in config['outputs']:
        if rule['methodId'] != 'ray.detector-power':
            continue
        reference = rule['parameters']['surface']
        if isinstance(reference, dict):
            reference = reference['value']
        prefix = 'experiment.surface.'
        if not isinstance(reference, str) or not reference.startswith(prefix):
            raise ValueError('Detector power requires an experiment.surface reference')
        group = reference[len(prefix):]
        selected = selectors(scene, group)
        keys = surface_keys(scene, group, solids)
        if len(selected) != 1 or len(keys) != 1 or not keys <= absorbing:
            raise ValueError('Detector power requires one ray.absorbing-detector surface in ray.domain')
        surface = next(iter(keys))
        solid = solids[surface.root_id]
        leaf = next(leaf for leaf in solid.leaves if leaf.node['nodeId'] == surface.source_node_id)
        if len(solid.leaves) != 1 or leaf.kind != 'box' or solid.expression.children != (0,):
            raise ValueError('Detector power requires an uncut Box face')
        patch = next(patch for patch in solid.patches if patch.reference == surface)
        grid = BoxGrid(rule['boxGrid'])
        if grid.shape[2] != 1:
            raise ValueError('Detector power requires gridShape=[Nu,Nv,1]')
        corners = np.asarray([patch.evaluate(u, v)[0] for u, v in product((0, 1), repeat=2)])
        local = grid.local_points(corners)
        size = np.asarray(grid.geometry['size'])
        expected = np.asarray([[u * size[0], v * size[1], size[2] / 2] for u, v in product((0, 1), repeat=2)])
        tolerance = 128 * np.finfo(float).eps * max(
            float(np.max(size)), float(np.max(np.abs(local))), float(np.max(np.abs(grid.geometry['origin']))))
        distances = np.linalg.norm(local[:, None, :] - expected[None, :, :], axis=2)
        if np.any(np.min(distances, axis=0) > tolerance) or np.any(np.min(distances, axis=1) > tolerance):
            raise ValueError('Detector observation Box must cover the full face at its z-cell center')
        tallies.append(DetectorTally(rule['key'], grid, definitions[rule['methodId']]['data'], frequencies, surface))
    return tallies


def launched_power_artifacts(config, descriptor, launched_power):
    definitions = {item['methodId']: item for item in descriptor['methods']['outputs']}
    frequencies = np.asarray(sorted(launched_power), dtype=np.float64)
    artifacts = {}
    for rule in config['outputs']:
        if rule['methodId'] != 'ray.launched-power':
            continue
        grid = BoxGrid(rule['boxGrid'])
        if grid.shape != (1, 1, 1):
            raise ValueError('Launched power requires gridShape=[1,1,1]')
        values = np.asarray([launched_power[frequency] for frequency in frequencies], dtype=np.float64)
        artifacts[rule['key']] = pack_box_grid(grid, definitions[rule['methodId']]['data'], values, frequencies=frequencies)
    return artifacts
