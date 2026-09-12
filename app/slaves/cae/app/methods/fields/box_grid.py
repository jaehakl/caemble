"""Passive Box sampling and the common seven-axis numerical result layout."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import product
from typing import Any

import numpy as np

from app.kernel.api.units import convert_ucum_value


@dataclass(frozen=True)
class BoxGrid:
    geometry: Mapping[str, Any]

    def __post_init__(self):
        size, origin = np.asarray(self.geometry["size"]), np.asarray(self.geometry["origin"])
        rotation, shape = np.asarray(self.geometry["rotation"]), np.asarray(self.geometry["gridShape"])
        if (size.shape != (3,) or origin.shape != (3,) or rotation.shape != (3, 3)
                or not all(np.all(np.isfinite(value)) for value in (size, origin, rotation))
                or np.any(size <= 0)):
            raise ValueError("Box Grid requires finite origin, positive size and a 3 by 3 rotation")
        if (shape.shape != (3,) or shape.dtype.kind not in "iu" or np.any(shape < 1)):
            raise ValueError("Box Grid gridShape requires three positive integers")
        if not np.allclose(rotation @ rotation.T, np.eye(3), rtol=0, atol=1e-8):
            raise ValueError("Box Grid rotation must be orthonormal")
        if self.geometry.get("source") not in ("experiment", "task") or not self.geometry.get("rootId"):
            raise ValueError("Box Grid requires its Experiment or Task geometry identity")
        convert_ucum_value(1, self.geometry["lengthUnit"], "m")

    @property
    def shape(self) -> tuple[int, int, int]:
        return tuple(int(size) for size in self.geometry["gridShape"])

    @property
    def axes(self) -> tuple[np.ndarray, ...]:
        return tuple((np.arange(count) + 0.5) * size / count
                     for size, count in zip(self.geometry["size"], self.shape, strict=True))

    def points(self, unit: str = "m") -> np.ndarray:
        local = np.stack(np.meshgrid(*self.axes, indexing="ij"), axis=-1)
        rotation = np.asarray(self.geometry["rotation"], dtype=float).reshape(3, 3)
        world = np.asarray(self.geometry["origin"], dtype=float) + local @ rotation.T
        return world * convert_ucum_value(1, self.geometry["lengthUnit"], unit)

    def local_points(self, points: np.ndarray, unit: str = "m") -> np.ndarray:
        scale = convert_ucum_value(1, self.geometry["lengthUnit"], unit)
        rotation = np.asarray(self.geometry["rotation"], dtype=float).reshape(3, 3)
        return (np.asarray(points) / scale - np.asarray(self.geometry["origin"])) @ rotation

    def contains(self, points: np.ndarray, unit: str = "m") -> np.ndarray:
        local = self.local_points(points, unit)
        size = np.asarray(self.geometry["size"])
        tolerance = np.maximum(size * 1e-12, np.finfo(float).eps)
        return np.all((local >= -tolerance) & (local <= size + tolerance), axis=-1)


def pack_box_grid(
    grid: BoxGrid,
    data: Mapping[str, Any],
    values: np.ndarray,
    *,
    times: Sequence[float] = (0.0,),
    frequencies: Sequence[float] = (0.0,),
) -> dict[str, Any]:
    """Pack x/y/z/time/frequency/component values, without changing their physics."""
    profile = data["boxGrid"]
    if not len(times) or not len(frequencies):
        raise ValueError("Box Grid time and frequency axes must contain at least one sample")
    dtype = np.dtype(data["dtype"])
    if dtype not in (np.dtype("float32"), np.dtype("float64")):
        raise ValueError("Box Grid numerical values require float32 or float64 storage")
    components = profile["components"]
    shape = (*grid.shape, len(times), len(frequencies), len(components))
    raw = np.asarray(values).reshape(shape)
    if tuple(profile["channels"]) == ("amplitude", "phase"):
        amplitude = np.abs(raw)
        phase = (np.angle(raw) + np.pi) % (2 * np.pi) - np.pi
        phase = np.where(amplitude == 0, 0.0, phase)
        packed = np.stack((amplitude, phase), axis=-2)
    else:
        if np.iscomplexobj(raw) and np.any(raw.imag != 0):
            raise ValueError("A complex Box field requires amplitude and phase channels")
        packed = raw.real[..., None, :]
    packed = np.asarray(packed, dtype=dtype)
    if tuple(profile["channels"]) == ("amplitude", "phase"):
        lower, upper = dtype.type(-np.pi), dtype.type(np.pi)
        if float(lower) < -np.pi:
            lower = np.nextafter(lower, dtype.type(0))
        if float(upper) >= np.pi:
            upper = np.nextafter(upper, dtype.type(0))
        packed[..., 1, :] = np.clip(packed[..., 1, :], lower, upper)
        packed[..., 1, :][packed[..., 0, :] == 0] = 0
    axes = [
        {"ticks": ticks, "spacing": size / count, "bounds": [0.0, size]}
        for ticks, size, count in zip(grid.axes, grid.geometry["size"], grid.shape, strict=True)
    ]
    axes.extend([
        {"ticks": np.asarray(times, dtype=float), "unit": "s"},
        {"ticks": np.asarray(frequencies, dtype=float), "unit": "Hz"},
        {"ticks": list(profile["channels"])},
        {"ticks": list(components)},
    ])
    return {"value": packed, "axes": axes,
            "boxGrid": {**dict(grid.geometry), **dict(profile)}}


@dataclass(frozen=True)
class RectilinearSampler:
    """Trilinear weights at arbitrary points; domain bounds are independent of ticks."""

    indices: tuple[tuple[np.ndarray, np.ndarray], ...]
    weights: tuple[np.ndarray, ...]
    valid: np.ndarray
    shape: tuple[int, ...]

    @classmethod
    def prepare(cls, axes, points, bounds):
        coordinates = np.asarray(points).reshape(-1, 3)
        indices, weights = [], []
        valid = np.ones(len(coordinates), dtype=bool)
        for dimension, (ticks, limits) in enumerate(zip(axes, bounds, strict=True)):
            ticks = np.asarray(ticks, dtype=float)
            position = coordinates[:, dimension]
            valid &= (position >= limits[0]) & (position <= limits[1])
            increasing = ticks[-1] >= ticks[0]
            ordered = ticks if increasing else ticks[::-1]
            if len(ordered) == 1:
                lo = hi = np.zeros(len(position), dtype=int)
                fraction = np.zeros(len(position))
            else:
                lo = np.clip(np.searchsorted(ordered, position) - 1, 0, len(ordered) - 2)
                hi = lo + 1
                fraction = (position - ordered[lo]) / (ordered[hi] - ordered[lo])
            indices.append((lo, hi) if increasing else (len(ticks) - 1 - lo, len(ticks) - 1 - hi))
            weights.append(fraction)
        return cls(tuple(indices), tuple(weights), valid, np.asarray(points).shape[:-1])

    def sample(self, values):
        values = np.asarray(values)
        trailing = values.shape[3:]
        result = np.zeros((len(self.valid), *trailing), dtype=values.dtype)
        for corner in product((0, 1), repeat=3):
            index = tuple(self.indices[axis][side] for axis, side in enumerate(corner))
            weight = np.ones(len(self.valid))
            for axis, side in enumerate(corner):
                weight *= self.weights[axis] if side else 1 - self.weights[axis]
            result += values[index] * weight.reshape((-1,) + (1,) * len(trailing))
        result[~self.valid] = 0
        return result.reshape((*self.shape, *trailing))


@dataclass(frozen=True)
class TetrahedralSampler:
    """Containing-element interpolation on the actual mesh, including empty probe Boxes."""

    cells: np.ndarray
    cell_indices: np.ndarray
    barycentric: np.ndarray
    shape: tuple[int, ...]

    @classmethod
    def prepare(cls, nodes, cells, points):
        from scipy.spatial import cKDTree

        nodes, cells = np.asarray(nodes), np.asarray(cells, dtype=int)
        samples = np.asarray(points).reshape(-1, 3)
        selected = np.full(len(samples), -1, dtype=int)
        weights = np.zeros((len(samples), 4))
        tree = cKDTree(samples)
        for index, cell in enumerate(cells):
            vertices = nodes[cell]
            center = vertices.mean(axis=0)
            radius = np.linalg.norm(vertices - center, axis=1).max()
            candidates = np.asarray(tree.query_ball_point(center, radius * (1 + 1e-12)), dtype=int)
            candidates = candidates[selected[candidates] < 0]
            if not len(candidates):
                continue
            matrix = (vertices[1:] - vertices[0]).T
            local = np.linalg.solve(matrix, (samples[candidates] - vertices[0]).T).T
            barycentric = np.column_stack((1 - local.sum(axis=1), local))
            inside = np.all(barycentric >= -1e-10, axis=1)
            selected[candidates[inside]] = index
            weights[candidates[inside]] = barycentric[inside]
        return cls(cells, selected, weights, np.asarray(points).shape[:-1])

    def sample(self, values, *, location="node"):
        values = np.asarray(values)
        trailing = values.shape[1:]
        result = np.zeros((len(self.cell_indices), *trailing), dtype=values.dtype)
        valid = self.cell_indices >= 0
        selected = self.cell_indices[valid]
        if location == "cell":
            result[valid] = values[selected]
        else:
            weights = self.barycentric[valid].reshape((-1, 4) + (1,) * len(trailing))
            result[valid] = (values[self.cells[selected]] * weights).sum(axis=1)
        return result.reshape((*self.shape, *trailing))


def voxel_frame(domain):
    axis = np.asarray(domain.axis)
    u = np.array([0.0, 1.0, 0.0]) - axis * axis[1]
    if np.linalg.norm(u) <= 1e-8:
        u = np.array([0.0, 0.0, 1.0]) - axis * axis[2]
    u /= np.linalg.norm(u)
    v = np.cross(axis, u)
    return np.column_stack((axis, u, v))


def sample_voxel_field(domain, values, grid: BoxGrid, unit: str):
    from app.methods.structured.voxel import axis_ticks

    axis, u, v = voxel_frame(domain).T
    points = (grid.points(unit) - domain.origin) @ np.column_stack((axis, v, u))
    bounds = ((-domain.length / 2, domain.length / 2),
              (domain.minimum_v, domain.minimum_v + domain.shape[2] * domain.v_spacing),
              (domain.minimum_u, domain.minimum_u + domain.shape[1] * domain.u_spacing))
    sampler = RectilinearSampler.prepare(axis_ticks(domain), points, bounds)
    cells = []
    for position, (lo, hi), count in zip(np.moveaxis(points, -1, 0), bounds,
                                       (domain.shape[0], domain.shape[2], domain.shape[1]), strict=True):
        cells.append(np.clip(np.floor((position - lo) / (hi - lo) * count).astype(int), 0, count - 1))
    occupied = domain.occupancy[(cells[0] * domain.shape[1] + cells[2]) * domain.shape[2] + cells[1]]
    sampled = sampler.sample(values)
    sampled[occupied == 0] = 0
    return sampled


def clip_box_polygon(polygon, grid: BoxGrid, unit="m"):
    """Clip a world-space planar polygon against the six faces of a rotated Box."""
    scale = convert_ucum_value(1, grid.geometry["lengthUnit"], unit)
    origin = np.asarray(grid.geometry["origin"]) * scale
    size = np.asarray(grid.geometry["size"]) * scale
    rotation = np.asarray(grid.geometry["rotation"])
    polygon = list((np.asarray(polygon) - origin) @ rotation)
    for axis in range(3):
        for bound, sign in ((0.0, 1), (size[axis], -1)):
            clipped = []
            for first, second in zip(polygon, polygon[1:] + polygon[:1]):
                a, b = sign * (first[axis] - bound), sign * (second[axis] - bound)
                if a >= 0:
                    clipped.append(first)
                if (a >= 0) != (b >= 0):
                    clipped.append(first + a / (a - b) * (second - first))
            polygon = clipped
    return np.asarray(polygon).reshape(-1, 3) @ rotation.T + origin


def box_intersects_cells(grid: BoxGrid, centers, half_extents, cell_rotation, unit="m"):
    """Exact separating-axis overlap of a rotated probe and orthogonal native cells."""
    centers = np.asarray(centers)
    scale = convert_ucum_value(1, grid.geometry["lengthUnit"], unit)
    rotation = np.asarray(grid.geometry["rotation"])
    b = np.asarray(grid.geometry["size"]) * scale / 2
    box_center = np.asarray(grid.geometry["origin"]) * scale + rotation @ b
    a = np.asarray(half_extents)
    relative = np.asarray(cell_rotation).T @ rotation
    absolute = np.abs(relative) + 1e-14
    offset = (box_center - centers.reshape(-1, 3)) @ cell_rotation
    overlap = np.ones(len(offset), dtype=bool)
    for i in range(3):
        overlap &= np.abs(offset[:, i]) <= a[i] + absolute[i] @ b
        overlap &= np.abs(offset @ relative[:, i]) <= b[i] + a @ absolute[:, i]
        for j in range(3):
            i1, i2, j1, j2 = (i + 1) % 3, (i + 2) % 3, (j + 1) % 3, (j + 2) % 3
            radius = a[i1] * absolute[i2, j] + a[i2] * absolute[i1, j]
            radius += b[j1] * absolute[i, j2] + b[j2] * absolute[i, j1]
            overlap &= np.abs(offset[:, i2] * relative[i1, j] - offset[:, i1] * relative[i2, j]) <= radius
    return overlap.reshape(centers.shape[:-1])
