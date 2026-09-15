"""Physical kernel, fluid forces and no-slip periodic-channel checks."""

import numpy as np
import pytest

from app.solvers.sph.formulation import evaluate, pressure, stable_timestep, step, wendland


def channel(rows=12):
    spacing = 1.0 / rows
    shape = (4, rows, 4)
    size = np.array(shape) * spacing
    points = np.stack(np.meshgrid(*[(np.arange(count) + 0.5) * spacing for count in shape], indexing="ij"), axis=-1).reshape(-1, 3)
    settings = {"h": 1.3 * spacing, "origin": np.zeros(3), "size": size, "periodic": np.array([True, False, True]), "density": 1000.0, "viscosity": 100.0, "soundSpeed": 10.0, "exponent": 7.0, "gravity": np.zeros(3)}
    return points, np.full(len(points), settings["density"]), np.full(len(points), settings["density"] * spacing**3), settings


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


def test_periodic_channel_reaches_analytic_steady_profile_under_refinement():
    errors = []
    for rows in (8, 16):
        points, density, mass, settings = channel(rows)
        settings["soundSpeed"] = 1.0
        settings["gravity"] = np.array([0.2, 0.0, 0.0])
        velocity = np.zeros_like(points)
        current = 0.0
        while current < 6.0:
            dt = min(stable_timestep(velocity, settings), 6.0 - current)
            points, velocity, density = step(points, velocity, density, mass, settings, dt)
            current += dt
        # u = gx/(2*nu) y(H-y), with gx=.2, nu=.1 and H=1.
        expected = points[:, 1] * (1 - points[:, 1])
        errors.append(np.linalg.norm(velocity[:, 0] - expected) / np.linalg.norm(expected))
        assert np.max(np.abs(density / settings["density"] - 1)) < 0.01
    assert errors[-1] < errors[0]
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


def test_transient_periodic_channel_velocity_converges_with_timestep():
    points, density, mass, settings = channel(8)
    settings["soundSpeed"] = 1.0
    settings["gravity"] = np.array([.2, 0., 0.])

    def solve(dt):
        positions, rho = points.copy(), density.copy()
        velocity = np.zeros_like(points)
        for _ in range(round(.4 / dt)):
            positions, velocity, rho = step(positions, velocity, rho, mass, settings, dt)
        return velocity

    reference = solve(.0025)
    errors = [np.linalg.norm(solve(dt) - reference) / np.linalg.norm(reference) for dt in (.02, .01, .005)]
    assert np.all(np.diff(errors) < 0)
    assert errors[-1] < .005


def test_closed_column_settles_by_four_seconds_without_wall_leakage():
    positions, density, mass, settings = channel(8)
    positions *= .2
    mass *= .2**3
    settings["size"] *= .2
    settings["h"] *= .2
    settings.update(soundSpeed=2., viscosity=10., gravity=np.array([0., -.1, 0.]))
    velocity = np.zeros_like(positions)
    count, total_mass, current = len(positions), float(np.sum(mass)), 0.
    # Starting at zero pressure excites an acoustic mode. Its viscous decay
    # time is about .81 s; two seconds still contains a measurable oscillation.
    # Verify three late snapshots, preserving the same 5% pressure criterion.
    for endpoint in (3., 3.5, 4.):
        while current < endpoint:
            dt = min(.003, stable_timestep(velocity, settings), endpoint - current)
            positions, velocity, density = step(positions, velocity, density, mass, settings, dt)
            current += dt
        values = pressure(density, settings["density"], settings["soundSpeed"])
        slope = np.polyfit(positions[:, 1], values, 1)[0]
        assert abs(slope + 100.) / 100. < .05
        assert np.max(np.linalg.norm(velocity, axis=1)) < 1e-3
        assert np.max(np.abs(density / settings["density"] - 1)) < .01
        assert np.all((positions[:, 1] > 0) & (positions[:, 1] < .2))
        assert len(positions) == count and float(np.sum(mass)) == total_mass
