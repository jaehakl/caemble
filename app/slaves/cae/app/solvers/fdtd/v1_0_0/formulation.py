from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import torch

from app.runtime_kernel.api import SolverInvocation, SolverResult
from app.runtime_kernel.api.world import task_scene

from .detectors import DetectorRegion, SpectralDetector, TimeDetector, requested_frequencies
from .materials import build_update_coefficients
from .physics import FDTDEngine, cell_center_fields
from .pml import CpmlState
from .setup import (
    PreparedDomain,
    _raw,
    _target_part,
    axis_aligned_box_bounds,
    detector_indices,
    prepare_domain,
)
from .sources import SoftElectricSource, validate_source_timing


_OUTPUT_TYPES = {
    "fdtd.time-electric-field": ("caemble.fdtd/time-electric-field@1", "electric"),
    "fdtd.time-magnetic-field": ("caemble.fdtd/time-magnetic-field@1", "magnetic"),
    "fdtd.spectral-electric-field": (
        "caemble.fdtd/spectral-electric-field@1",
        "electric",
    ),
    "fdtd.spectral-magnetic-field": (
        "caemble.fdtd/spectral-magnetic-field@1",
        "magnetic",
    ),
}


@dataclass(frozen=True, slots=True)
class _SourcePlan:
    mask: np.ndarray[Any, np.dtype[np.bool_]]
    waveform: str
    amplitude: np.ndarray[Any, np.dtype[np.float32]]
    frequency: float
    bandwidth: float
    start_time: float
    end_time: float


@dataclass(frozen=True, slots=True)
class _OutputPlan:
    method: str
    key: str
    artifact_type: str
    field_kind: str
    region: DetectorRegion
    time_stride: int | None = None
    frequencies: np.ndarray[Any, np.dtype[np.float64]] | None = None


async def run(invocation: SolverInvocation) -> SolverResult:
    prepared = await prepare_domain(invocation)
    simulation_time = _positive_float(
        invocation.config["parameters"]["simulationTime"], "simulationTime"
    )
    step_count = math.ceil(simulation_time / prepared.dt)
    source_plans = await _prepare_sources(invocation, prepared)
    output_plans = await _prepare_outputs(invocation, prepared)
    spectral_elements = sum(
        int(plan.frequencies.size)
        * plan.region.z.size
        * plan.region.y.size
        * plan.region.x.size
        * 3
        for plan in output_plans
        if plan.frequencies is not None
    )
    estimated_bytes = estimate_device_bytes(
        prepared.domain.topology.global_shape,
        prepared.pml_cells,
        spectral_elements,
    )
    device = select_device(
        int(np.prod(prepared.domain.topology.global_shape)), estimated_bytes
    )

    try:
        widths = tuple(
            torch.as_tensor(axis, dtype=torch.float32, device=device)
            for axis in prepared.widths
        )
        coefficients = build_update_coefficients(
            prepared.relative_permittivity,
            prepared.epsilon_infinity,
            prepared.plasma_frequency,
            prepared.collision_frequency,
            prepared.model_codes,
            prepared.dt,
            prepared.domain.topology.periodic,
            device,
        )
        center_wavelength = _positive_float(
            invocation.config["parameters"]["pmlCenterWavelength"],
            "pmlCenterWavelength",
        )
        cpml = (
            CpmlState(
                tuple(reversed(prepared.domain.topology.global_shape)),
                prepared.pml_cells,
                prepared.dt,
                center_wavelength,
                device,
            )
            if any(lower or upper for lower, upper in prepared.pml_cells)
            else None
        )
        engine = FDTDEngine(
            widths,
            prepared.domain.topology.periodic,
            prepared.dt,
            coefficients,
            cpml,
        )
        sources = [
            SoftElectricSource(
                torch.as_tensor(plan.mask, dtype=torch.bool, device=device),
                plan.waveform,
                torch.as_tensor(plan.amplitude, dtype=torch.float32, device=device),
                plan.frequency,
                plan.bandwidth,
                plan.start_time,
                plan.end_time,
            )
            for plan in source_plans
        ]
        for source in sources:
            validate_source_timing(
                source,
                simulation_time=simulation_time,
                dt=prepared.dt,
            )
        time_detectors = [
            TimeDetector(
                plan.key,
                plan.artifact_type,
                plan.field_kind,
                plan.region,
                plan.time_stride,
            )
            for plan in output_plans
            if plan.time_stride is not None
        ]
        spectral_detectors = [
            SpectralDetector(
                plan.key,
                plan.artifact_type,
                plan.field_kind,
                plan.region,
                plan.frequencies,
                device,
            )
            for plan in output_plans
            if plan.frequencies is not None
        ]
    except torch.OutOfMemoryError as error:
        if device.type == "cuda":
            torch.cuda.empty_cache()
            raise MemoryError(
                "FDTD CUDA allocation failed after VRAM preflight; CPU fallback is disabled"
            ) from error
        raise

    centered_electric, centered_magnetic = cell_center_fields(
        engine.electric,
        engine.magnetic,
        prepared.domain.topology.periodic,
    )
    for detector in time_detectors:
        values = centered_electric if detector.field_kind == "electric" else centered_magnetic
        detector.capture(0, 0.0, values, final=False)

    progress_interval = max(1, step_count // 100)
    for step in range(1, step_count + 1):
        if invocation.cancellation is not None:
            invocation.cancellation.raise_if_cancelled()
        source_time = (step - 1) * prepared.dt
        for source in sources:
            source.apply(engine.electric, source_time)
        engine.step_magnetic()
        engine.step_electric()
        time = step * prepared.dt
        if time_detectors or spectral_detectors:
            centered_electric, centered_magnetic = cell_center_fields(
                engine.electric,
                engine.magnetic,
                prepared.domain.topology.periodic,
            )
            for detector in time_detectors:
                values = (
                    centered_electric
                    if detector.field_kind == "electric"
                    else centered_magnetic
                )
                detector.capture(step, time, values, final=step == step_count)
            for detector in spectral_detectors:
                values = (
                    centered_electric
                    if detector.field_kind == "electric"
                    else centered_magnetic
                )
                detector.capture(time, values)
        if invocation.progress is not None and (
            step == step_count or step % progress_interval == 0
        ):
            await invocation.progress(
                {"stage": "fdtd-propagation", "completed": step, "total": step_count}
            )

    artifacts = {
        detector.key: detector.artifact()
        for detector in (*time_detectors, *spectral_detectors)
    }
    pml_cell_size = _positive_float(
        invocation.config["parameters"]["pmlCellSize"], "pmlCellSize"
    )
    warning = (
        "pmlCellSize exceeds pmlCenterWavelength/15; CPML absorption may be inaccurate"
        if pml_cell_size > center_wavelength / 15.0
        else ""
    )
    return SolverResult(
        artifacts=artifacts,
        observations={
            "timeSteps": step_count,
            "totalCells": int(np.prod(prepared.domain.topology.global_shape)),
            "device": str(device),
            "pmlResolutionWarning": warning,
        },
    )


def select_device(total_cells: int, estimated_bytes: int) -> torch.device:
    if total_cells < 100_000 or not torch.cuda.is_available():
        return torch.device("cpu")
    free_bytes, _ = torch.cuda.mem_get_info()
    if estimated_bytes > free_bytes:
        raise MemoryError(
            "FDTD requires approximately "
            f"{estimated_bytes / 2**30:.2f} GiB of VRAM but only "
            f"{free_bytes / 2**30:.2f} GiB is free; CPU fallback is disabled"
        )
    return torch.device("cuda")


def estimate_device_bytes(
    shape_xyz: tuple[int, int, int],
    pml_cells: tuple[tuple[int, int], tuple[int, int], tuple[int, int]],
    spectral_elements: int,
) -> int:
    cell_count = math.prod(shape_xyz)
    pml_memory = 0
    for axis, (lower, upper) in enumerate(pml_cells):
        transverse_area = math.prod(
            shape_xyz[other] for other in range(3) if other != axis
        )
        pml_memory += 4 * (lower + upper) * transverse_area
    float_elements = 44 * cell_count + pml_memory
    return 4 * float_elements + 8 * spectral_elements


async def _prepare_sources(
    invocation: SolverInvocation,
    prepared: PreparedDomain,
) -> list[_SourcePlan]:
    scene = task_scene(invocation.world)
    plans: list[_SourcePlan] = []
    for index, rule in enumerate(invocation.config["boundaryConditions"]):
        if rule["methodId"] != "fdtd.soft-electric-source":
            continue
        part = _target_part(scene, rule, f"source {index}")
        bounds = await axis_aligned_box_bounds(invocation, scene, part, f"source {index}")
        x, y, z = detector_indices(
            bounds,
            prepared.domain.core_bounds,
            prepared.domain.cell_ticks,
            (1, 1, 1),
            f"source {index}",
        )
        mask = np.zeros(tuple(reversed(prepared.domain.topology.global_shape)), dtype=np.bool_)
        mask[np.ix_(z, y, x)] = True
        parameters = rule["parameters"]
        amplitude = np.asarray(_raw(parameters["amplitude"]), dtype=np.float32)
        if amplitude.shape != (3,) or np.any(~np.isfinite(amplitude)):
            raise ValueError("source amplitude must be finite [Ex, Ey, Ez]")
        plans.append(
            _SourcePlan(
                mask,
                str(_raw(parameters["waveform"])),
                amplitude,
                _positive_float(parameters["frequency"], "frequency"),
                _nonnegative_float(parameters["bandwidth"], "bandwidth"),
                _nonnegative_float(parameters["startTime"], "startTime"),
                _positive_float(parameters["endTime"], "endTime"),
            )
        )
    return plans


async def _prepare_outputs(
    invocation: SolverInvocation,
    prepared: PreparedDomain,
) -> list[_OutputPlan]:
    scene = task_scene(invocation.world)
    plans: list[_OutputPlan] = []
    for index, rule in enumerate(invocation.config["outputs"]):
        method = rule["methodId"]
        if method not in _OUTPUT_TYPES:
            continue
        part = _target_part(scene, rule, f"detector {index}")
        bounds = await axis_aligned_box_bounds(
            invocation, scene, part, f"detector {index}"
        )
        parameters = rule["parameters"]
        strides = tuple(
            _positive_int(parameters[name], name)
            for name in ("strideX", "strideY", "strideZ")
        )
        x, y, z = detector_indices(
            bounds,
            prepared.domain.core_bounds,
            prepared.domain.cell_ticks,
            strides,
            f"detector {index}",
        )
        domain_ticks = prepared.domain.cell_ticks
        region = DetectorRegion(
            z,
            y,
            x,
            (
                np.asarray(domain_ticks[2], dtype=np.float64)[z],
                np.asarray(domain_ticks[1], dtype=np.float64)[y],
                np.asarray(domain_ticks[0], dtype=np.float64)[x],
            ),
        )
        artifact_type, field_kind = _OUTPUT_TYPES[method]
        if method.startswith("fdtd.time-"):
            plans.append(
                _OutputPlan(
                    method,
                    rule["key"],
                    artifact_type,
                    field_kind,
                    region,
                    time_stride=_positive_int(parameters["timeStride"], "timeStride"),
                )
            )
        else:
            plans.append(
                _OutputPlan(
                    method,
                    rule["key"],
                    artifact_type,
                    field_kind,
                    region,
                    frequencies=requested_frequencies(
                        _nonnegative_float(parameters["frequencyStart"], "frequencyStart"),
                        _nonnegative_float(parameters["frequencyStop"], "frequencyStop"),
                        _positive_float(parameters["frequencyStep"], "frequencyStep"),
                        prepared.dt,
                    ),
                )
            )
    return plans


def _positive_int(value: Any, name: str) -> int:
    raw = _raw(value)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
        raise ValueError(f"{name} must be a positive integer")
    result = int(raw)
    if result <= 0 or result != raw:
        raise ValueError(f"{name} must be a positive integer")
    return result


def _positive_float(value: Any, name: str) -> float:
    result = float(_raw(value))
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"{name} must be positive and finite")
    return result


def _nonnegative_float(value: Any, name: str) -> float:
    result = float(_raw(value))
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"{name} must be non-negative and finite")
    return result


__all__ = ["estimate_device_bytes", "run", "select_device"]
