from __future__ import annotations

import numpy as np
import torch

from app.solvers.fdtd.v1_0_0.materials import build_update_coefficients
from app.solvers.fdtd.v1_0_0.physics import EPSILON_0, MU_0, FDTDEngine
from app.solvers.fdtd.v1_0_0.pml import CpmlState


def _vacuum_engine(cell_count: int, *, pml_cells: int = 0) -> FDTDEngine:
    cell_size = 10e-9
    dt = 0.5 * cell_size / 299_792_458.0
    shape = (1, 1, cell_count)
    relative_permittivity = np.ones(shape, dtype=np.float32)
    absent = np.full(shape, np.nan, dtype=np.float32)
    models = np.zeros(shape, dtype=np.uint8)
    periodic = (False, True, True)
    widths = (
        torch.full((cell_count,), cell_size, dtype=torch.float32),
        torch.ones(1, dtype=torch.float32),
        torch.ones(1, dtype=torch.float32),
    )
    coefficients = build_update_coefficients(
        relative_permittivity,
        absent,
        absent,
        absent,
        models,
        dt,
        periodic,
        torch.device("cpu"),
    )
    cpml = (
        CpmlState(
            shape,
            ((pml_cells, pml_cells), (0, 0), (0, 0)),
            dt,
            300e-9,
            torch.device("cpu"),
        )
        if pml_cells
        else None
    )
    return FDTDEngine(widths, periodic, dt, coefficients, cpml)


def _launch_right_going_pulse(engine: FDTDEngine, center: int, width: float) -> None:
    x = torch.arange(engine.electric.shape[-1], dtype=torch.float32)
    pulse = torch.exp(-0.5 * ((x - center) / width) ** 2) * 1e-3
    engine.electric[2, 0, 0] = pulse
    engine.magnetic[1, 0, 0] = -pulse / (MU_0 / EPSILON_0) ** 0.5


def test_vacuum_pulse_propagates_at_the_grid_light_speed() -> None:
    engine = _vacuum_engine(160)
    _launch_right_going_pulse(engine, 40, 5.0)

    for _ in range(80):
        engine.step_magnetic()
        engine.step_electric()

    assert torch.argmax(torch.abs(engine.electric[2, 0, 0])).item() == 80


def test_cpml_reduces_returned_pulse_energy_by_three_orders_of_magnitude() -> None:
    reflected = _vacuum_engine(120)
    absorbed = _vacuum_engine(120, pml_cells=15)
    _launch_right_going_pulse(reflected, 45, 5.0)
    _launch_right_going_pulse(absorbed, 45, 5.0)

    for _ in range(500):
        reflected.step_magnetic()
        reflected.step_electric()
        absorbed.step_magnetic()
        absorbed.step_electric()

    reflected_energy = torch.sum(reflected.electric[..., 15:-15].square())
    absorbed_energy = torch.sum(absorbed.electric[..., 15:-15].square())
    assert absorbed_energy < reflected_energy * 1e-3
