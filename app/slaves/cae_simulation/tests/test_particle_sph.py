"""Small SPH kernel, force, boundary and single-step checks."""

import numpy as np
import pytest

from app.solvers.sph.formulation import evaluate, pressure, stable_timestep, step, wendland
from tests.sph_fixtures import channel


def test_wendland_is_normalized_in_three_dimensions_and_has_compact_support():
    radius = np.linspace(0, 2, 10001)
    values, radial = wendland(radius, 1.0)
    assert np.trapezoid(4 * np.pi * radius**2 * values, radius) == pytest.approx(1, abs=1e-10)
    assert values[-1] == 0 and radial[-1] == 0
    np.testing.assert_allclose(radial[1:-1], np.gradient(values, radius)[1:-1], atol=2e-7)


def test_uniform_rest_is_stationary_with_no_slip_walls():
    points, density, mass, settings = channel(8)
    acceleration, density_rate = evaluate(points, np.zeros_like(points), density, mass, settings)
    np.testing.assert_allclose(acceleration, 0, atol=1e-12)
    np.testing.assert_allclose(density_rate, 0, atol=1e-12)


def test_internal_sph_forces_conserve_linear_momentum():
    points, density, mass, settings = channel(6)
    settings["periodic"] = np.ones(3, dtype=bool)
    rng = np.random.default_rng(510)
    velocity = rng.normal(0, 0.01, points.shape)
    density = density + rng.normal(0, 0.5, density.shape)
    acceleration, _ = evaluate(points, velocity, density, mass, settings)
    np.testing.assert_allclose((mass[:, None] * acceleration).sum(axis=0), 0, atol=1e-9)


def test_periodic_channel_poiseuille_viscous_acceleration_is_consistent():
    errors = []
    for rows in (8, 16):
        points, density, mass, settings = channel(rows)
        velocity = np.zeros_like(points)
        velocity[:, 0] = points[:, 1] * (1 - points[:, 1])
        acceleration, density_rate = evaluate(points, velocity, density, mass, settings)
        expected = -2.0 * settings["viscosity"] / settings["density"]
        interior = (points[:, 1] > 2 * settings["h"]) & (points[:, 1] < 1 - 2 * settings["h"])
        errors.append(np.linalg.norm(acceleration[interior, 0] - expected) / (abs(expected) * np.sqrt(np.count_nonzero(interior))))
        np.testing.assert_allclose(density_rate, 0, atol=1e-10)
    assert errors[-1] < 0.05


def test_hydrostatic_tait_column_balances_gravity_and_wall_pressure():
    points, _, mass, settings = channel(16)
    settings["gravity"] = np.array([0.0, -0.1, 0.0])
    # Integrate dp/dy=-rho*g with the independently specified Tait EOS.
    density = 1000 * (1 + 6 * 0.1 * (1 - points[:, 1]) / 100)**(1 / 6)
    acceleration, density_rate = evaluate(points, np.zeros_like(points), density, mass, settings)
    assert np.max(np.abs(acceleration[:, 1])) < 0.03 * 0.1
    np.testing.assert_allclose(density_rate, 0, atol=1e-12)


def test_midpoint_evolves_density_pressure_and_preserves_failed_input():
    points, density, mass, settings = channel(6)
    velocity = np.zeros_like(points)
    velocity[:, 1] = 0.01 * np.sin(2 * np.pi * points[:, 1])
    before = points.copy(), velocity.copy(), density.copy()
    _, _, advanced_density = step(points, velocity, density, mass, settings, stable_timestep(velocity, settings) / 4)
    assert np.max(np.abs(advanced_density - density)) > 1e-5
    assert np.max(np.abs(pressure(advanced_density, settings["density"], settings["soundSpeed"]))) > 1e-5
    for value, original in zip((points, velocity, density), before):
        np.testing.assert_array_equal(value, original)


def test_sph_periodic_neighbors_preserve_results_under_particle_reordering():
    points, density, mass, settings = channel(6)
    rng = np.random.default_rng(19)
    order = rng.permutation(len(points))
    reverse = np.argsort(order)
    velocity = rng.normal(0, .001, points.shape)
    baseline = step(points, velocity, density, mass, settings, .0001)
    reordered = step(points[order], velocity[order], density[order], mass[order], settings, .0001)
    for actual, expected in zip(reordered, baseline):
        np.testing.assert_allclose(actual[reverse], expected, atol=1e-12, rtol=1e-12)
