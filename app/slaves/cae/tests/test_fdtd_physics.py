from __future__ import annotations

import math
from dataclasses import replace

import numpy as np
import pytest
import torch

from app.solvers.fdtd.v1_0_0.detectors import (
    DetectorRegion,
    SpectralDetector,
    TimeDetector,
    requested_frequencies,
)
from app.solvers.fdtd.v1_0_0.materials import build_update_coefficients
from app.solvers.fdtd.v1_0_0.physics import (
    EPSILON_0,
    FDTDEngine,
    backward_difference,
    cell_center_fields,
    forward_difference,
)
from app.solvers.fdtd.v1_0_0.pml import CpmlState
from app.solvers.fdtd.v1_0_0.sources import SoftElectricSource, validate_source_timing


def test_unequal_interface_derivative_matches_weighted_ghost_expression() -> None:
    values = torch.tensor([[[0.0, 1.0, 4.0, 10.0]]])
    widths = torch.tensor([1.0, 1.0, 2.0, 2.0])

    forward = forward_difference(values, widths, axis=0, periodic=False)
    backward = backward_difference(values, widths, axis=0, periodic=False)
    weighted_interface = (values[0, 0, 2] - values[0, 0, 1]) / (
        0.5 * (widths[1] + widths[2])
    )

    torch.testing.assert_close(forward[0, 0, 1], weighted_interface)
    torch.testing.assert_close(backward[0, 0, 2], weighted_interface)


def test_periodic_difference_wraps_the_packed_grid_seam() -> None:
    values = torch.tensor([[[2.0, 5.0, 11.0]]])
    widths = torch.tensor([1.0, 2.0, 3.0])
    seam = (values[0, 0, 0] - values[0, 0, -1]) / (
        0.5 * (widths[0] + widths[-1])
    )

    periodic_forward = forward_difference(values, widths, axis=0, periodic=True)
    periodic_backward = backward_difference(values, widths, axis=0, periodic=True)
    nonperiodic_forward = forward_difference(values, widths, axis=0, periodic=False)
    nonperiodic_backward = backward_difference(values, widths, axis=0, periodic=False)

    torch.testing.assert_close(periodic_forward[0, 0, -1], seam)
    torch.testing.assert_close(periodic_backward[0, 0, 0], seam)
    assert nonperiodic_forward[0, 0, -1] == 0
    assert nonperiodic_backward[0, 0, 0] == 0


@pytest.mark.parametrize(
    ("model_code", "has_drude", "formula"),
    (
        (0, False, "default"),
        (1, True, "rc"),
        (2, True, "trc"),
        (2, False, "default"),
    ),
)
def test_material_models_match_their_direct_one_step_recurrence(
    model_code: int,
    has_drude: bool,
    formula: str,
) -> None:
    dt = 1.0e-12
    relative_permittivity = 2.5
    epsilon_infinity = 3.0
    plasma_frequency = 1.0e9
    collision_frequency = 2.0e8
    shape = (1, 1, 1)
    coefficients = build_update_coefficients(
        np.full(shape, relative_permittivity, dtype=np.float32),
        np.full(
            shape,
            epsilon_infinity if has_drude else np.nan,
            dtype=np.float32,
        ),
        np.full(
            shape,
            plasma_frequency if has_drude else np.nan,
            dtype=np.float32,
        ),
        np.full(
            shape,
            collision_frequency if has_drude else np.nan,
            dtype=np.float32,
        ),
        np.full(shape, model_code, dtype=np.uint8),
        dt,
        (True, True, True),
        torch.device("cpu"),
    )

    if formula != "default":
        omega_p = 2.0 * math.pi * plasma_frequency
        omega_c = 2.0 * math.pi * collision_frequency
        decay = math.exp(-omega_c * dt)
        chi0 = omega_p**2 * dt / omega_c - (omega_p / omega_c) ** 2 * (1.0 - decay)
        dchi0 = -((omega_p / omega_c) * (1.0 - decay)) ** 2
        if formula == "rc":
            inverse = 1.0 / (epsilon_infinity + chi0)
            expected = (
                inverse,
                inverse * dt / EPSILON_0,
                -inverse,
                decay,
                -dchi0,
                0.0,
            )
        else:
            inverse = 1.0 / (epsilon_infinity + 0.5 * chi0)
            expected = (
                inverse * (epsilon_infinity - 0.5 * chi0),
                inverse * dt / EPSILON_0,
                -inverse,
                decay,
                -0.5 * dchi0,
                -0.5 * dchi0,
            )

    if formula == "default":
        assert coefficients.previous is None
        assert coefficients.current is None
        assert coefficients.current_decay is None
        assert coefficients.current_new is None
        assert coefficients.current_old is None
        torch.testing.assert_close(
            coefficients.curl,
            torch.full_like(
                coefficients.curl,
                dt / (EPSILON_0 * relative_permittivity),
            ),
        )
        engine = FDTDEngine(
            (torch.ones(1), torch.ones(1), torch.ones(1)),
            (True, True, True),
            dt,
            coefficients,
        )
        engine.electric.fill_(0.2)
        engine.step_electric()
        torch.testing.assert_close(engine.electric, torch.full_like(engine.electric, 0.2))
        assert engine.current is None
        return

    for actual, direct in zip(
        (
            coefficients.previous,
            coefficients.curl,
            coefficients.current,
            coefficients.current_decay,
            coefficients.current_new,
            coefficients.current_old,
        ),
        expected,
        strict=True,
    ):
        torch.testing.assert_close(actual, torch.full_like(actual, direct), rtol=2e-5, atol=1e-7)

    engine = FDTDEngine(
        (torch.ones(1), torch.ones(1), torch.ones(1)),
        (True, True, True),
        dt,
        coefficients,
    )
    old_electric = 0.2
    old_current = 0.05
    engine.electric.fill_(old_electric)
    assert engine.current is not None
    engine.current.fill_(old_current)
    engine.step_electric()
    expected_electric = expected[0] * old_electric + expected[2] * old_current
    expected_current = (
        expected[3] * old_current
        + expected[4] * expected_electric
        + expected[5] * old_electric
    )
    torch.testing.assert_close(
        engine.electric,
        torch.full_like(engine.electric, expected_electric),
        rtol=2e-5,
        atol=1e-7,
    )
    torch.testing.assert_close(
        engine.current,
        torch.full_like(engine.current, expected_current),
        rtol=2e-5,
        atol=1e-7,
    )


@pytest.mark.parametrize(("model_code", "formula"), ((1, "rc"), (2, "trc")))
def test_drude_interface_weights_constitutive_update_but_not_current_recurrence(
    model_code: int,
    formula: str,
) -> None:
    dt = 1.0e-12
    relative_permittivity = 2.5
    epsilon_infinity = 3.0
    plasma_frequency = 1.0e9
    collision_frequency = 2.0e8
    shape = (1, 2, 1)
    drude = np.full(shape, np.nan, dtype=np.float32)
    drude[:, 0, :] = epsilon_infinity
    plasma = np.full(shape, np.nan, dtype=np.float32)
    plasma[:, 0, :] = plasma_frequency
    collision = np.full(shape, np.nan, dtype=np.float32)
    collision[:, 0, :] = collision_frequency
    models = np.zeros(shape, dtype=np.uint8)
    models[:, 0, :] = model_code

    coefficients = build_update_coefficients(
        np.full(shape, relative_permittivity, dtype=np.float32),
        drude,
        plasma,
        collision,
        models,
        dt,
        (True, True, True),
        torch.device("cpu"),
    )

    omega_p = 2.0 * math.pi * plasma_frequency
    omega_c = 2.0 * math.pi * collision_frequency
    decay = math.exp(-omega_c * dt)
    chi0 = omega_p**2 * dt / omega_c - (omega_p / omega_c) ** 2 * (1.0 - decay)
    dchi0 = -((omega_p / omega_c) * (1.0 - decay)) ** 2
    inverse = 1.0 / (
        epsilon_infinity + (chi0 if formula == "rc" else 0.5 * chi0)
    )
    target = (0, 0, 0, 0)
    expected_previous = (
        0.5 + 0.5 * inverse
        if formula == "rc"
        else 0.5 + 0.5 * inverse * (epsilon_infinity - 0.5 * chi0)
    )
    expected_curl = 0.5 * dt / (EPSILON_0 * relative_permittivity) + 0.5 * inverse * dt / EPSILON_0

    assert coefficients.previous is not None
    assert coefficients.current is not None
    assert coefficients.current_decay is not None
    assert coefficients.current_new is not None
    assert coefficients.current_old is not None
    assert coefficients.previous[target] == pytest.approx(expected_previous, rel=2e-5)
    assert coefficients.curl[target] == pytest.approx(expected_curl, rel=2e-5)
    assert coefficients.current[target] == pytest.approx(-0.5 * inverse, rel=2e-5)
    assert coefficients.current_decay[target] == pytest.approx(decay, rel=2e-5)
    assert coefficients.current_new[target] == pytest.approx(
        (-dchi0 if formula == "rc" else -0.5 * dchi0),
        rel=5e-5,
    )
    assert coefficients.current_old[target] == pytest.approx(
        (0.0 if formula == "rc" else -0.5 * dchi0),
        rel=5e-5,
    )


def test_gaussian_and_cw_sources_use_reference_cutoff_envelopes() -> None:
    mask = torch.ones((1, 1, 1), dtype=torch.bool)
    amplitude = torch.tensor([1.0, -2.0, 0.5])
    gaussian = SoftElectricSource(mask, "gaussian", amplitude, 0.137, 2.0, 1.0, 8.0)
    continuous = replace(gaussian, waveform="cw")
    width = 1.0 / gaussian.bandwidth
    center = gaussian.start_time + 5.0 * width

    for time, envelope in (
        (gaussian.start_time, math.exp(-12.5)),
        (center, 1.0),
        (gaussian.end_time, math.exp(-0.5 * ((gaussian.end_time - center) / width) ** 2)),
    ):
        expected = amplitude * (
            envelope * math.sin(2.0 * math.pi * gaussian.frequency * time)
        )
        torch.testing.assert_close(gaussian.value(time), expected)

    for time, envelope in (
        (continuous.start_time, math.exp(-12.5)),
        (center, 1.0),
        (continuous.end_time, 1.0),
        (continuous.end_time + 5.0 * width, math.exp(-12.5)),
    ):
        expected = amplitude * (
            envelope * math.sin(2.0 * math.pi * continuous.frequency * time)
        )
        torch.testing.assert_close(continuous.value(time), expected)


def test_source_timing_rejects_carrier_and_bandwidth_above_nyquist() -> None:
    source = SoftElectricSource(
        torch.ones((1, 1, 1), dtype=torch.bool),
        "gaussian",
        torch.ones(3),
        5.1,
        0.0,
        0.0,
        1.0,
    )
    with pytest.raises(ValueError, match="Nyquist"):
        validate_source_timing(source, simulation_time=1.0, dt=0.1)
    with pytest.raises(ValueError, match="half its bandwidth"):
        validate_source_timing(
            replace(source, frequency=4.5, bandwidth=2.0),
            simulation_time=1.0,
            dt=0.1,
        )


def test_spectral_detector_returns_requested_frequency_raw_dft_real_and_imaginary() -> None:
    region = DetectorRegion(
        np.asarray([0]),
        np.asarray([0]),
        np.asarray([0]),
        (np.asarray([0.0]), np.asarray([0.0]), np.asarray([0.0])),
    )
    frequencies = requested_frequencies(0.25, 0.25, 0.25, dt=1.0)
    detector = SpectralDetector(
        "spectrum",
        "fdtd/spectral-field",
        "electric",
        region,
        frequencies,
        torch.device("cpu"),
    )
    for time in range(4):
        values = torch.zeros((3, 1, 1, 1))
        angle = 2.0 * math.pi * frequencies[0] * time
        values[0, 0, 0, 0] = math.cos(angle) + 2.0 * math.sin(angle)
        detector.capture(float(time), values)

    artifact = detector.artifact()
    real = artifact.members["real"]["value"]
    imaginary = artifact.members["imag"]["value"]
    np.testing.assert_allclose(real[0, 0, 0, 0], [0.5, 0.0, 0.0], atol=1e-6)
    np.testing.assert_allclose(imaginary[0, 0, 0, 0], [-1.0, 0.0, 0.0], atol=1e-6)


def test_time_detector_keeps_stride_samples_and_off_stride_final_sample() -> None:
    region = DetectorRegion(
        np.asarray([0]),
        np.asarray([0]),
        np.asarray([0]),
        (np.asarray([0.0]), np.asarray([0.0]), np.asarray([0.0])),
    )
    detector = TimeDetector("history", "fdtd/time-field", "magnetic", region, 2)
    for step in range(4):
        detector.capture(
            step,
            step * 0.1,
            torch.full((3, 1, 1, 1), float(step)),
            final=step == 3,
        )

    member = detector.artifact().members["field"]
    np.testing.assert_allclose(member["axes"][0]["ticks"], [0.0, 0.2, 0.3])
    np.testing.assert_allclose(member["value"][:, 0, 0, 0, 0], [0.0, 2.0, 3.0])


def test_electric_and_magnetic_fields_are_interpolated_to_cell_centers() -> None:
    z, y, x = torch.meshgrid(
        torch.arange(2, dtype=torch.float32),
        torch.arange(2, dtype=torch.float32),
        torch.arange(2, dtype=torch.float32),
        indexing="ij",
    )
    values = 100.0 * z + 10.0 * y + x
    electric = torch.stack((values, values, values))
    magnetic = torch.stack((values, values, values))

    centered_electric, centered_magnetic = cell_center_fields(
        electric,
        magnetic,
        (False, False, False),
    )

    torch.testing.assert_close(centered_electric[:, 0, 0, 0], torch.tensor([55.0, 50.5, 5.5]))
    torch.testing.assert_close(centered_magnetic[:, 0, 0, 0], torch.tensor([0.5, 5.0, 50.0]))


def test_cpml_allocates_psi_only_for_touched_slabs() -> None:
    cpml = CpmlState(
        shape=(4, 5, 6),
        pml_cells=((1, 2), (0, 1), (2, 0)),
        dt=1.0e-12,
        center_wavelength=1.0,
        device=torch.device("cpu"),
    )
    derivative = torch.ones((4, 5, 6))

    assert cpml.allocated_memory_elements == 0
    cpml.correct("electric", field_component=1, derivative_axis=0, derivative=derivative)
    assert cpml.allocated_memory_elements == 4 * 5 * (1 + 2)
    cpml.correct("electric", field_component=1, derivative_axis=0, derivative=derivative)
    assert cpml.allocated_memory_elements == 4 * 5 * (1 + 2)
    cpml.correct("magnetic", field_component=0, derivative_axis=1, derivative=derivative)
    assert cpml.allocated_memory_elements == 4 * 5 * (1 + 2) + 4 * 1 * 6
    assert cpml.allocated_memory_elements < 2 * derivative.numel()


def test_cpml_grading_matches_reference_yee_positions_on_both_sides() -> None:
    count = 4
    cpml = CpmlState(
        shape=(1, 1, count * 2),
        pml_cells=((count, count), (0, 0), (0, 0)),
        dt=1.0e-12,
        center_wavelength=1.0,
        device=torch.device("cpu"),
    )

    electric_depth = torch.tensor(
        [3.5, 2.5, 1.5, 0.5, 0.5, 1.5, 2.5, 3.5]
    ) / count
    magnetic_depth = torch.tensor(
        [3.0, 2.0, 1.0, 0.0, 1.0, 2.0, 3.0, 4.0]
    ) / count
    torch.testing.assert_close(
        cpml._coefficients[("electric", 0, "kappa")],
        1.0 + 10.0 * electric_depth**4,
    )
    torch.testing.assert_close(
        cpml._coefficients[("magnetic", 0, "kappa")],
        1.0 + 10.0 * magnetic_depth**4,
    )
