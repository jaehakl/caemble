from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from app.kernel.api import BundleValue
from app.kernel.api.world import target_group

from .domain import surface_triangle_keys

@dataclass(slots=True)
class Detector:
    triangle_keys: set[tuple[str, int]]


@dataclass(slots=True)
class PathCollector:
    maximum_paths: int
    paths: list[Any] = field(default_factory=list)
    detected_power: float = 0.0
    tallies: list[Any] = field(default_factory=list)

    def score(self, origin, direction, length, power, absorption, wavelength):
        for tally in self.tallies:
            tally.score(origin, direction, length, power, absorption, wavelength)

    def finish(self, ray: Any) -> None:
        if len(self.paths) < self.maximum_paths and len(ray.vertices) >= 2:
            self.paths.append(ray)

    def bundle(self) -> BundleValue:
        vertices: list[np.ndarray[Any, Any]] = []
        offsets = [0]
        powers: list[float] = []
        path_wavelengths: list[float] = []
        events: list[int] = []
        for path in self.paths:
            vertices.extend(path.vertices)
            offsets.append(len(vertices))
            powers.extend(path.powers)
            path_wavelengths.append(path.wavelength)
            events.extend(path.events)
        return BundleValue("caemble.ray/paths@1", {
            "vertices": {
                "value": np.asarray(vertices, dtype=np.float32).reshape((-1, 3)),
                "axes": [{"implicitOrdinal": True}, {"ticks": ["x", "y", "z"]}],
            },
            "pathOffsets": {
                "value": np.asarray(offsets, dtype=np.uint32),
                "axes": [{"implicitOrdinal": True}],
            },
            "segmentPower": {
                "value": np.asarray(powers, dtype=np.float32),
                "axes": [{"implicitOrdinal": True}],
            },
            "pathWavelength": {
                "value": np.asarray(path_wavelengths, dtype=np.float32),
                "axes": [{"implicitOrdinal": True}],
            },
            "segmentEvent": {
                "value": np.asarray(events, dtype=np.uint8),
                "axes": [{"implicitOrdinal": True}],
            },
        })


def build_detectors(config, scene, meshes):
    return [Detector(surface_triangle_keys(scene, target_group(rule, "surface"), meshes))
            for rule in config["boundaryConditions"] if rule["methodId"] == "ray.absorbing-detector"]


@dataclass
class VolumeTally:
    key: str
    grid: Any
    data: Any
    frequencies: np.ndarray
    values: np.ndarray = field(init=False)

    def __post_init__(self):
        self.values = np.zeros((*self.grid.shape, len(self.frequencies), len(self.data["boxGrid"]["components"])), dtype=float)
        from app.kernel.api.units import convert_ucum_value
        scale = convert_ucum_value(1, self.grid.geometry["lengthUnit"], "m")
        self.origin = np.asarray(self.grid.geometry["origin"], dtype=float) * scale
        self.size = np.asarray(self.grid.geometry["size"], dtype=float) * scale
        self.rotation = np.asarray(self.grid.geometry["rotation"], dtype=float)
        self.widths = self.size / self.grid.shape
        self.volume = np.prod(self.widths)

    def interval(self, origin, direction, length=np.inf):
        local = (np.asarray(origin) - self.origin) @ self.rotation
        velocity = np.asarray(direction) @ self.rotation
        start, end = 0.0, length
        for axis in range(3):
            if abs(velocity[axis]) <= 1e-15:
                if local[axis] < 0 or local[axis] > self.size[axis]:
                    return None
                continue
            first, last = sorted((-local[axis] / velocity[axis],
                                  (self.size[axis] - local[axis]) / velocity[axis]))
            start, end = max(start, first), min(end, last)
        return (start, end, local, velocity) if end > start else None

    def score(self, origin, direction, length, power, absorption, wavelength):
        interval = self.interval(origin, direction, length)
        if interval is None:
            return
        start, end, local, velocity = interval
        crossings = [start, end]
        for axis in range(3):
            if abs(velocity[axis]) > 1e-15:
                distances = (np.arange(1, self.grid.shape[axis]) * self.widths[axis] - local[axis]) / velocity[axis]
                crossings.extend(distances[(distances > start) & (distances < end)])
        crossings = np.unique(crossings)
        frequency = int(np.searchsorted(self.frequencies, 299792458.0 / wavelength))
        for first, last in zip(crossings[:-1], crossings[1:], strict=True):
            position = local + velocity * ((first + last) / 2)
            cell = tuple(np.clip(np.floor(position / self.widths).astype(int), 0, np.asarray(self.grid.shape) - 1))
            integral = (power * (last - first) if absorption == 0 else
                        power * math.exp(-absorption * first) * -math.expm1(-absorption * (last - first)) / absorption)
            contribution = integral / self.volume
            if self.values.shape[-1] == 3:
                self.values[(*cell, frequency)] += contribution * np.asarray(direction)
            else:
                self.values[(*cell, frequency, 0)] += contribution

    def artifact(self):
        from app.methods.fields.box_grid import pack_box_grid
        return pack_box_grid(self.grid, self.data, self.values, frequencies=self.frequencies)


def build_volume_tallies(config, descriptor, wavelengths):
    from app.methods.fields.box_grid import BoxGrid
    frequencies = np.unique([299792458.0 / wavelength for wavelength in wavelengths])
    if not len(frequencies):
        frequencies = np.array([0.0])
    definitions = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    return [VolumeTally(rule["key"], BoxGrid(rule["boxGrid"]), definitions[rule["methodId"]]["data"], frequencies)
            for rule in config["outputs"]]
