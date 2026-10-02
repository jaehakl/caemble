"""Explicit SPH physical-history and refinement validation."""

import numpy as np
import pytest

from app.solvers.sph.formulation import pressure, stable_timestep, step
from tests.sph_fixtures import channel

pytestmark = pytest.mark.validation


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
