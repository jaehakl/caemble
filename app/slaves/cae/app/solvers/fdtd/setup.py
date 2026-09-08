from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from app.methods.geometry import TriangularMesh
from app.methods.structured import rasterize_mesh_cell_centers
from app.kernel.api import SolverInvocation
from app.kernel.api.world import experiment_scene, geometry_parts, task_scene

from .domain import Bounds3D, FDTDDomain, FDTDRegion, build_fdtd_domain
from .materials import DRUDE_METHOD_CODES, MaterialProperties, material_properties
from .physics import LIGHT_SPEED


@dataclass(frozen=True, slots=True)
class PreparedDomain:
    domain: FDTDDomain
    epsilon_instantaneous: np.ndarray[Any, np.dtype[np.float32]]
    plasma_frequency: np.ndarray[Any, np.dtype[np.float32]]
    damping_frequency: np.ndarray[Any, np.dtype[np.float32]]
    model_codes: np.ndarray[Any, np.dtype[np.uint8]]
    widths: tuple[np.ndarray[Any, np.dtype[np.float32]], ...]
    pml_cells: tuple[tuple[int, int], tuple[int, int], tuple[int, int]]
    dt: float


async def prepare_domain(invocation: SolverInvocation) -> PreparedDomain:
    config = invocation.config
    main_rule = _one_rule(config, "initializations", "fdtd.main-region", required=True)
    buffer_rule = _one_rule(config, "initializations", "fdtd.buffer-region", required=False)
    task = task_scene(invocation.world)
    main_part = _target_part(task, main_rule, "main region")
    main_bounds = await axis_aligned_box_bounds(invocation, task, main_part, "main region")
    main_cell_sizes = tuple(
        _positive_float(main_rule["parameters"][name], name)
        for name in ("cellSizeX", "cellSizeY", "cellSizeZ")
    )
    main_drude_method = _drude_method(main_rule["parameters"]["drudeMethod"])
    buffer_part = None
    buffer_region = None
    buffer_cell_size = None
    if buffer_rule is not None:
        buffer_part = _target_part(task, buffer_rule, "buffer region")
        buffer_bounds = await axis_aligned_box_bounds(
            invocation, task, buffer_part, "buffer region"
        )
        buffer_cell_size = _positive_float(
            buffer_rule["parameters"]["cellSize"], "cellSize"
        )
        buffer_region = FDTDRegion(
            buffer_bounds,
            buffer_part,
            _drude_method(buffer_rule["parameters"]["drudeMethod"]),
        )

    parameters = config["parameters"]
    periodic = tuple(
        _boolean(parameters[name], name)
        for name in ("periodicX", "periodicY", "periodicZ")
    )
    pml_type = str(_raw(parameters["pmlType"]))
    if pml_type != "cpml":
        raise ValueError(f"unsupported pmlType {pml_type!r}")
    domain = build_fdtd_domain(
        FDTDRegion(main_bounds, main_part, main_drude_method),
        main_cell_sizes,
        buffer=buffer_region,
        buffer_cell_size=buffer_cell_size,
        periodic=periodic,
        pml_thickness=_positive_float(parameters["pmlThickness"], "pmlThickness"),
        pml_cell_size=_positive_float(parameters["pmlCellSize"], "pmlCellSize"),
    )
    shape = tuple(reversed(domain.topology.global_shape))
    epsilon_instantaneous = np.empty(shape, dtype=np.float32)
    plasma_frequency = np.full(shape, np.nan, dtype=np.float32)
    damping_frequency = np.full(shape, np.nan, dtype=np.float32)
    model_codes = np.empty(shape, dtype=np.uint8)
    property_cache: dict[tuple[str, str, str], MaterialProperties] = {}

    for block in domain.topology.blocks:
        metadata = domain.blocks[block.index]
        part = metadata.background
        properties = _cached_material(
            property_cache,
            invocation,
            part,
            "task",
            "mainBackground" if part["id"] == main_part["id"] else "bufferBackground",
        )
        index = tuple(reversed(block.global_slices))
        _paint_material(
            index,
            properties,
            epsilon_instantaneous,
            plasma_frequency,
            damping_frequency,
        )
        model_codes[index] = DRUDE_METHOD_CODES[metadata.drude_method]

    experiment = experiment_scene(invocation.world)
    x_ticks, y_ticks, z_ticks = domain.cell_ticks
    for root in experiment["roots"]:
        mesh = await invocation.geometry.triangular_mesh(
            experiment,
            root["id"],
            invocation.descriptor["referenceLengthUnit"],
            invocation.progress,
        )
        mask = await rasterize_mesh_cell_centers(
            mesh,
            x_ticks,
            y_ticks,
            z_ticks,
            invocation.progress,
        )
        if not np.any(mask):
            continue
        properties = _cached_material(property_cache, invocation, root, "experiment", "geometryOverlay")
        _paint_material(
            mask,
            properties,
            epsilon_instantaneous,
            plasma_frequency,
            damping_frequency,
        )

    drude_cells = np.isfinite(plasma_frequency)
    if np.any(drude_cells & (model_codes == 0)):
        raise ValueError("Drude Material occupies a region whose drudeMethod is 'none'; select RC or TRC")
    model_codes[~drude_cells] = 0
    widths = tuple(
        np.asarray(
            [segment.cell_size for segment in domain.topology.axes[axis] for _ in range(segment.cell_count)],
            dtype=np.float32,
        )
        for axis in range(3)
    )
    pml_cells = tuple(
        (
            domain.topology.axes[axis][0].cell_count
            if domain.topology.axes[axis][0].tag == "pml"
            else 0,
            domain.topology.axes[axis][-1].cell_count
            if domain.topology.axes[axis][-1].tag == "pml"
            else 0,
        )
        for axis in range(3)
    )
    dt = 0.5 * min(float(np.min(axis_widths)) for axis_widths in widths) / LIGHT_SPEED
    return PreparedDomain(
        domain,
        epsilon_instantaneous,
        plasma_frequency,
        damping_frequency,
        model_codes,
        widths,
        pml_cells,
        dt,
    )


async def axis_aligned_box_bounds(
    invocation: SolverInvocation,
    scene: dict[str, Any],
    part: dict[str, Any],
    label: str,
) -> Bounds3D:
    mesh = await invocation.geometry.triangular_mesh(
        scene,
        part["id"],
        invocation.descriptor["referenceLengthUnit"],
        invocation.progress,
    )
    return box_bounds_from_mesh(mesh, label)


def box_bounds_from_mesh(mesh: TriangularMesh, label: str) -> Bounds3D:
    if mesh.vertices.size == 0 or mesh.triangles.size == 0:
        raise ValueError(f"{label} must be a non-empty axis-aligned rectangular box")
    minimum = np.min(mesh.vertices, axis=0)
    maximum = np.max(mesh.vertices, axis=0)
    extent = maximum - minimum
    if np.any(~np.isfinite(extent)) or np.any(extent <= 0):
        raise ValueError(f"{label} must have positive finite x, y, and z extents")
    tolerance = max(float(np.max(extent)) * 1e-8, 1e-12)
    areas = np.zeros((3, 2), dtype=np.float64)
    for triangle_indices in mesh.triangles:
        triangle = mesh.vertices[triangle_indices]
        face = None
        for axis in range(3):
            if np.all(np.abs(triangle[:, axis] - minimum[axis]) <= tolerance):
                face = (axis, 0)
                break
            if np.all(np.abs(triangle[:, axis] - maximum[axis]) <= tolerance):
                face = (axis, 1)
                break
        if face is None:
            raise ValueError(f"{label} must have faces parallel to Cartesian axes")
        areas[face] += 0.5 * np.linalg.norm(
            np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
        )
    for axis in range(3):
        expected = float(np.prod(np.delete(extent, axis)))
        if not np.allclose(areas[axis], expected, rtol=1e-6, atol=tolerance**2):
            raise ValueError(f"{label} must be one closed axis-aligned rectangular box")
    return tuple((float(minimum[axis]), float(maximum[axis])) for axis in range(3))


def detector_indices(
    bounds: Bounds3D,
    core_bounds: Bounds3D,
    ticks: tuple[tuple[float, ...], tuple[float, ...], tuple[float, ...]],
    strides: tuple[int, int, int],
    label: str,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    tolerance = max(max(maximum - minimum for minimum, maximum in core_bounds) * 1e-10, 1e-12)
    if any(
        bounds[axis][0] < core_bounds[axis][0] - tolerance
        or bounds[axis][1] > core_bounds[axis][1] + tolerance
        for axis in range(3)
    ):
        raise ValueError(f"{label} must lie completely inside the main/buffer core and outside PML")
    selected = []
    for axis in range(3):
        axis_ticks = np.asarray(ticks[axis], dtype=np.float64)
        indices = np.flatnonzero(
            (axis_ticks >= bounds[axis][0] - tolerance)
            & (axis_ticks <= bounds[axis][1] + tolerance)
        )[:: strides[axis]]
        if indices.size == 0:
            raise ValueError(f"{label} does not contain an FDTD cell center on axis {axis}")
        selected.append(indices.astype(np.int64, copy=False))
    return selected[0], selected[1], selected[2]


def _cached_material(
    cache: dict[tuple[str, str, str], MaterialProperties],
    invocation: SolverInvocation,
    part: dict[str, Any],
    source: str,
    role: str,
) -> MaterialProperties:
    material_name = part.get("material", {}).get("name")
    key = (source, str(material_name), role)
    if key not in cache:
        cache[key] = material_properties(
            invocation.world,
            part,
            source=source,
            role=role,
        )
    return cache[key]


def _paint_material(
    index: Any,
    properties: MaterialProperties,
    epsilon_instantaneous: np.ndarray,
    plasma_frequency: np.ndarray,
    damping_frequency: np.ndarray,
) -> None:
    epsilon_instantaneous[index] = properties.epsilon_instantaneous
    if properties.has_drude:
        plasma_frequency[index] = properties.plasma_frequency
        damping_frequency[index] = properties.damping_frequency
    else:
        plasma_frequency[index] = np.nan
        damping_frequency[index] = np.nan


def _target_part(scene: dict[str, Any], rule: dict[str, Any], label: str) -> dict[str, Any]:
    targets = rule.get("target", [])
    if len(targets) != 1 or not targets[0].startswith("task.geometry."):
        raise ValueError(f"{label} must target exactly one task.geometry group")
    parts = geometry_parts(scene, targets[0][len("task.geometry.") :])
    if len(parts) != 1:
        raise ValueError(f"{label} must resolve to exactly one Geometry")
    return parts[0]


def _one_rule(
    config: dict[str, Any],
    category: str,
    method: str,
    *,
    required: bool,
) -> dict[str, Any] | None:
    rules = [rule for rule in config[category] if rule["methodId"] == method]
    if (required and len(rules) != 1) or (not required and len(rules) > 1):
        expectation = "exactly one" if required else "zero or one"
        raise ValueError(f"{method} requires {expectation} rule")
    return rules[0] if rules else None


def _drude_method(value: Any) -> str:
    model = str(_raw(value))
    if model not in DRUDE_METHOD_CODES:
        raise ValueError(f"unsupported FDTD Drude method {model!r}")
    return model


def _positive_float(value: Any, name: str) -> float:
    result = float(_raw(value))
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"{name} must be positive and finite")
    return result


def _boolean(value: Any, name: str) -> bool:
    result = _raw(value)
    if not isinstance(result, bool):
        raise ValueError(f"{name} must be boolean")
    return result


def _raw(value: Any) -> Any:
    return value.get("value") if isinstance(value, dict) else value


__all__ = [
    "PreparedDomain",
    "axis_aligned_box_bounds",
    "box_bounds_from_mesh",
    "detector_indices",
    "prepare_domain",
]


def _positive_int(value: Any, name: str) -> int:
    raw = _raw(value)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
        raise ValueError(f"{name} must be a positive integer")
    result = int(raw)
    if result <= 0 or result != raw:
        raise ValueError(f"{name} must be a positive integer")
    return result


def _nonnegative_float(value: Any, name: str) -> float:
    result = float(_raw(value))
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"{name} must be non-negative and finite")
    return result


