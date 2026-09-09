from __future__ import annotations

import math
from typing import Any

import numpy as np
import torch

from app.kernel.api import CancellationToken, ProgressReporter
from .detectors import OutputPlan, SpectralDetector, TimeDetector
from .materials import build_update_coefficients
from .physics import FDTDEngine, cell_center_fields
from .pml import CpmlState
from .setup import PreparedDomain, _positive_float
from .sources import SourcePlan, SoftElectricSource, validate_source_timing
from .tfsf import TfsfSource


def allocate_simulation(
    prepared: PreparedDomain,
    source_plans: list[SourcePlan],
    output_plans: list[OutputPlan],
    parameters: dict[str, Any],
    simulation_time: float,
) -> tuple[FDTDEngine, list[SoftElectricSource], list[TimeDetector], list[SpectralDetector]]:
    """Select the device and allocate the engine, sources, and detector buffers."""
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
            prepared.epsilon_instantaneous,
            prepared.plasma_frequency,
            prepared.damping_frequency,
            prepared.model_codes,
            prepared.dt,
            prepared.domain.topology.periodic,
            device,
        )
        center_wavelength = _positive_float(
            parameters["pmlCenterWavelength"],
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
            if plan.axis is None
        ]
        for plan in source_plans:
            if plan.axis is not None:
                if plan.waveform != "gaussian" or plan.bandwidth <= 0:
                    raise ValueError("TFSF requires a Gaussian pulse with positive bandwidth")
                if plan.end_time <= plan.start_time or plan.end_time > simulation_time:
                    raise ValueError("TFSF requires startTime < endTime <= simulationTime")
                if plan.frequency + 0.5 * plan.bandwidth > 0.5 / prepared.dt:
                    raise ValueError("TFSF source exceeds the timestep Nyquist limit")
                engine.incident_sources.append(TfsfSource(
                    engine, plan.mask, plan.axis, plan.direction, plan.amplitude,
                    plan.frequency, plan.bandwidth, plan.start_time, plan.end_time,
                    math.ceil(simulation_time / prepared.dt),
                ))
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

    return engine, sources, time_detectors, spectral_detectors


async def propagate(
    engine: FDTDEngine,
    sources: list[SoftElectricSource],
    time_detectors: list[TimeDetector],
    spectral_detectors: list[SpectralDetector],
    step_count: int,
    progress: ProgressReporter | None,
    cancellation: CancellationToken | None,
) -> None:
    """Advance source, magnetic field, electric field, then sample detectors."""
    centered_electric, centered_magnetic = cell_center_fields(
        engine.electric,
        engine.magnetic,
        engine.periodic,
    )
    for detector in time_detectors:
        values = centered_electric if detector.field_kind == "electric" else centered_magnetic
        detector.capture(0, 0.0, values, final=False)

    progress_interval = max(1, step_count // 100)
    for step in range(1, step_count + 1):
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        source_time = (step - 1) * engine.dt
        for source in sources:
            source.apply(engine.electric, source_time)
        for source in engine.incident_sources:
            source.inject(source_time)
        engine.step_magnetic()
        for source in engine.incident_sources:
            source.step_magnetic()
        engine.step_electric()
        for source in engine.incident_sources:
            source.step_electric()
        time = step * engine.dt
        if time_detectors or spectral_detectors:
            centered_electric, centered_magnetic = cell_center_fields(
                engine.electric,
                engine.magnetic,
                engine.periodic,
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
        if progress is not None and (
            step == step_count or step % progress_interval == 0
        ):
            await progress(
                {"stage": "fdtd-propagation", "completed": step, "total": step_count}
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


