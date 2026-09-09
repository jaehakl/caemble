from __future__ import annotations

import numpy as np
import pytest
import torch
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.solvers.fdtd.physics import EPSILON_0, ElectricUpdateCoefficients, FDTDEngine
from app.solvers.fdtd.tfsf import TfsfSource
from app.solvers.fdtd import sources


@pytest.fixture(autouse=True)
def single_threaded_torch():
    previous = torch.get_num_threads()
    torch.set_num_threads(1)
    yield
    torch.set_num_threads(previous)


@pytest.mark.parametrize("axis", [0, 1, 2])
@pytest.mark.parametrize("direction", [-1, 1])
def test_tfsf_matches_auxiliary_plane_wave_and_cancels_all_exterior_faces(axis, direction):
    widths = tuple(torch.full((24,), 20e-9) for _ in range(3))
    dt = 0.5 * 20e-9 / 299792458
    coefficient = ElectricUpdateCoefficients(None, torch.tensor(dt / EPSILON_0), None, None, None, None)
    engine = FDTDEngine(widths, (False, False, False), dt, coefficient)
    mask = np.zeros((24, 24, 24), dtype=bool)
    mask[4:20, 4:20, 4:20] = True
    amplitude = np.eye(3)[(axis + 1) % 3]
    source = TfsfSource(engine, mask, axis, direction, amplitude, 3e14, 4e14, 0, 30e-15, 900)
    engine.incident_sources.append(source)
    maximum_error = 0.0
    maximum_field = 0.0
    for step in range(900):
        source.inject(step * dt)
        engine.step_magnetic()
        source.step_magnetic()
        engine.step_electric()
        source.step_electric()
        if step % 25 == 0:
            shape = [1, 1, 1]
            shape[2-axis] = 24
            offset = source.padding - source.line_start
            expected = source.electric[offset:offset+24].reshape(shape) * torch.as_tensor(mask)
            actual = engine.electric[(axis+1)%3]
            maximum_error = max(maximum_error, float(torch.max(torch.abs(actual-expected))))
            maximum_field = max(maximum_field, float(torch.max(torch.abs(expected))))
            assert float(torch.max(torch.abs(engine.electric[:, ~mask]))) < 2e-5
    assert maximum_field > 0.1
    assert maximum_error / maximum_field < 3e-5


def test_tfsf_rejects_longitudinal_polarization():
    widths = tuple(torch.full((10,), 20e-9) for _ in range(3))
    engine = FDTDEngine(widths, (False, False, False), 1e-17,
                        ElectricUpdateCoefficients(None, torch.tensor(1e-17/EPSILON_0), None, None, None, None))
    with pytest.raises(ValueError, match="transverse"):
        TfsfSource(engine, np.ones((10, 10, 10), dtype=bool), 2, -1,
                   np.array([0., 0., 1.]), 3e14, 2e14, 0, 1e-14, 100)


@pytest.mark.parametrize("direction", [-1, 1])
def test_broadband_auxiliary_line_reverse_wave_at_grid_transitions(direction):
    # Match the example's 10 nm main grid and 50 nm buffer/PML spacing.
    widths = (torch.full((3,), 10e-9), torch.full((3,), 10e-9),
              torch.tensor([50e-9]*22 + [10e-9]*80 + [50e-9]*22))
    dt = 0.5 * 10e-9 / 299792458
    engine = FDTDEngine(widths, (False, False, False), dt,
                        ElectricUpdateCoefficients(None, torch.tensor(dt/EPSILON_0), None, None, None, None))
    mask = np.zeros((124,3,3),dtype=bool)
    mask[30:95,1,1] = True
    source = TfsfSource(engine, mask, 2, direction,
                       np.array([1.,0.,0.]), 287301105833333.3, 6e14, 0, 30e-15, 6000)
    probes = np.arange(35,90,3)
    frequencies = 299792458 / (np.arange(800,1501,100)*1e-9)
    spectral = np.zeros((8,len(probes)),dtype=np.complex128)
    for step in range(6000):
        source.inject(step*dt)
        source.step_magnetic()
        source.step_electric()
        spectral += np.exp(-2j*np.pi*frequencies*(step+1)*dt)[:,None] * source.electric[source.padding-source.line_start+probes].numpy()
    positions = probes*10e-9
    for frequency, values in zip(frequencies,spectral):
        numerical_k = 2/10e-9 * np.arcsin(np.sin(np.pi*frequency*dt)/(299792458*dt/10e-9))
        basis = np.column_stack((np.exp(-1j*direction*numerical_k*positions), np.exp(1j*direction*numerical_k*positions)))
        forward, reverse = np.linalg.lstsq(basis,values,rcond=None)[0]
        assert abs(reverse/forward) < 1e-4


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["vacuum", "material", "spacing", "pml", "periodic"])
async def test_tfsf_preparation_requires_uniform_vacuum_collar(monkeypatch, case):
    monkeypatch.setattr(sources, "axis_aligned_box_bounds", AsyncMock(return_value=((4.,8.),)*3))
    scene = {"roots":[{"id":"box"}], "geometryGroups":[{"name":"source", "rootIds":["box"]}]}
    invocation = SimpleNamespace(world={"task":scene}, config={"boundaryConditions":[{
        "methodId":"fdtd.tfsf-plane-wave", "target":["task.geometry.source"],
        "parameters":{"waveform":"gaussian", "amplitude":[1,0,0], "axis":"z", "direction":-1,
                      "frequency":1e6, "bandwidth":1e6, "startTime":0, "endTime":1e-5},
    }]})
    prepared = SimpleNamespace(
        domain=SimpleNamespace(core_bounds=((0.,12.),)*3, cell_ticks=(tuple(np.arange(12)+0.5),)*3,
                               topology=SimpleNamespace(global_shape=(12,12,12),periodic=(case=="periodic",False,False))),
        pml_cells=((3,3),)*3 if case=="pml" else ((1,1),)*3,
        widths=tuple(np.ones(12) for _ in range(3)),
        epsilon_instantaneous=np.ones((12,12,12)), plasma_frequency=np.full((12,12,12),np.nan),
    )
    if case == "material": prepared.epsilon_instantaneous[4,6,6] = 2
    if case == "spacing": prepared.widths[0][5] = 1.1
    if case == "vacuum":
        plans = await sources.prepare_sources(invocation,prepared)
        assert len(plans) == 1 and plans[0].mask.sum() == 64
        assert plans[0].axis == 2 and plans[0].direction == -1
    else:
        with pytest.raises(ValueError,match={"material":"vacuum", "spacing":"uniform", "pml":"CPML", "periodic":"nonperiodic"}[case]):
            await sources.prepare_sources(invocation,prepared)
