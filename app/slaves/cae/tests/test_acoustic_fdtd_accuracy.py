"""Independent traveling-wave convergence and normalized transient/FEM comparison.

The fixed benchmark is a 0.5 x 0.1 x 0.1 m duct, rho=1.2 kg/m^3,
c=343 m/s, rigid sides and a matched resistive termination. A 250 Hz sine
under a 4 ms Hann envelope gives a finite pulse with useful input spectrum
throughout 100--400 Hz. Fourier pressure is divided by this actual input
velocity spectrum; neither an ideal impulse nor raw output FFT is assumed.
"""

import numpy as np
import pytest

from app.methods.fields.box_grid import TetrahedralSampler
from app.solvers.pressure_acoustics.harmonic_fem.formulation import prepare_operators
from app.solvers.pressure_acoustics.harmonic_fem.harmonic import solve_harmonic
from app.solvers.pressure_acoustics.transient_fdtd.domain import CartesianAcousticGrid
from app.solvers.pressure_acoustics.transient_fdtd.sources import AcousticFaceRule, tone_burst_average
from app.solvers.pressure_acoustics.transient_fdtd.stepping import advance_step, initial_fields
from tests.acoustic_fixtures import driven_boundaries, tube


def run_pulse_duct(divisions, dt=1e-5):
    grid = CartesianAcousticGrid(np.zeros(3), np.array([.5, .1, .1]), divisions, 1.2, 343., {})
    times = np.arange(round(.016 / dt) + 1) * dt
    probes = np.array([.125, .25, .375])
    source = {"amplitude": -1., "frequency": 250., "startTime": 0., "duration": .004}
    rules = [
        AcousticFaceRule(0, 0, "acoustics.tone-burst-velocity", source),
        AcousticFaceRule(0, 1, "acoustics.impedance", {"resistance": grid.density * grid.sound_speed}),
    ]
    pressure, velocities = initial_fields(grid)
    samples = np.zeros((len(times), len(probes)))
    centers = (np.arange(divisions[0]) + .5) * grid.spacing[0]
    for step, (start, end) in enumerate(zip(times[:-1], times[1:]), start=1):
        normal_velocity = tone_burst_average(source, start, end)
        pressure = advance_step(grid, pressure, velocities, rules, dt, {(0, 0): normal_velocity})
        # The uniform face excitation has an exact transverse constant mode.
        samples[step] = np.interp(probes, centers, pressure.mean(axis=(1, 2)))
    return times, probes, samples


@pytest.fixture(scope="module")
def pulse_convergence():
    frequencies = np.linspace(100., 400., 13)
    waveforms, responses = [], []
    for divisions in ((10, 2, 2), (20, 4, 4), (40, 8, 8)):
        times, probes, samples = run_pulse_duct(divisions)
        # Independent closed-form source values, not the stepping implementation.
        phase = times / .004
        velocity = np.where((phase >= 0) & (phase <= 1), .5 * (1 - np.cos(2 * np.pi * phase)) * np.sin(2 * np.pi * 250 * times), 0.)
        fourier = np.exp(-2j * np.pi * times[:, None] * frequencies)
        input_spectrum = np.trapezoid(velocity[:, None] * fourier, times, axis=0)
        assert np.min(abs(input_spectrum)) > .5 * np.max(abs(input_spectrum))
        responses.append(np.trapezoid(samples[:, :, None] * fourier[:, None], times, axis=0) / input_spectrum)
        waveforms.append(samples)
    shifted = times[:, None] - probes / 343.
    phase = shifted / .004
    expected_waveform = np.where((phase >= 0) & (phase <= 1),
                                 411.6 * .5 * (1 - np.cos(2 * np.pi * phase)) * np.sin(2 * np.pi * 250 * shifted), 0.)
    expected_response = 411.6 * np.exp(-2j * np.pi * probes[:, None] * frequencies / 343.)
    return frequencies, probes, waveforms, responses, expected_waveform, expected_response


def test_three_spatial_levels_converge_to_signed_delayed_analytic_pulse(pulse_convergence, record_property):
    _, _, waveforms, responses, expected_waveform, expected_response = pulse_convergence
    waveform_errors = [float(np.linalg.norm(waveform - expected_waveform) / np.linalg.norm(expected_waveform)) for waveform in waveforms]
    # Incident pressure per unit inlet velocity is rho*c, so zero crossings do
    # not appear in the normalization denominator for either phase or amplitude.
    response_errors = [float(np.max(abs(response - expected_response)) / 411.6) for response in responses]
    assert waveform_errors[2] < waveform_errors[1] < waveform_errors[0], waveform_errors
    assert response_errors[2] < response_errors[1] < response_errors[0], response_errors
    assert waveform_errors[-1] < .01, waveform_errors
    assert response_errors[-1] < .01, response_errors
    assert np.min(waveforms[-1]) < -100 and np.max(waveforms[-1]) > 100
    record_property("fdtd_waveform_relative_l2", waveform_errors)
    record_property("fdtd_complex_response_incident_normalized_max", response_errors)


@pytest.mark.asyncio
async def test_independently_converged_fem_and_fdtd_agree_for_the_same_velocity_input(pulse_convergence, record_property):
    frequencies, probes, _, fdtd_responses, _, expected_response = pulse_convergence
    # These frequencies span the declared input band; FEM error is checked
    # independently before comparing either method against the other.
    selected = np.array([0, 6, 12])
    frequencies = frequencies[selected]
    coordinates = np.column_stack((probes, np.full(len(probes), .05), np.full(len(probes), .05)))
    expected = expected_response[:, selected]
    fem_errors = []
    for divisions in ((10, 2, 2), (20, 4, 4), (40, 8, 8)):
        model = tube(divisions)
        solution = await solve_harmonic(prepare_operators(model), driven_boundaries(model, frequencies), frequencies)
        response = TetrahedralSampler.prepare(model.points, model.cells, coordinates).sample(solution.pressure)
        fem_errors.append(float(np.max(abs(response - expected)) / 411.6))
        assert solution.relative_residuals.max() < 1e-8
    assert fem_errors[2] < fem_errors[1] < fem_errors[0], fem_errors
    assert fem_errors[-1] < .01, fem_errors
    difference = float(np.max(abs(response - fdtd_responses[-1][:, selected])) / 411.6)
    assert difference < .02, difference
    record_property("fem_complex_response_incident_normalized_max", fem_errors)
    record_property("fem_fdtd_complex_response_incident_normalized_max", difference)
