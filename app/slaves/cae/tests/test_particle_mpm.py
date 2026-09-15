"""Independent mechanics and transfer checks for three-dimensional APIC."""

import numpy as np
import pytest

from app.solvers.mpm.formulation import (
    grid_to_particle, neo_hookean, particle_to_grid, stable_timestep, step,
)


def particle_cloud():
    points = np.stack(np.meshgrid(*[np.linspace(0.32, 0.68, 4)] * 3, indexing="ij"), axis=-1).reshape(-1, 3)
    return points, np.full(len(points), 0.02)


def test_quadratic_transfer_reproduces_affine_fields_and_mass():
    points, mass = particle_cloud()
    affine = np.array([[0.1, -0.3, 0.2], [0.3, 0.2, -0.1], [-0.2, 0.1, -0.2]])
    velocity = points @ affine.T + [0.3, -0.2, 0.1]
    grid_mass, momentum, prepared = particle_to_grid(points, velocity, np.broadcast_to(affine, (len(points), 3, 3)), mass, np.zeros(3), 0.1, (11, 11, 11))
    grid_velocity = np.divide(momentum, grid_mass[:, None], out=np.zeros_like(momentum), where=grid_mass[:, None] > 0)
    restored, gradient, derivative = grid_to_particle(grid_velocity, prepared, 0.1)
    np.testing.assert_allclose(grid_mass.sum(), mass.sum(), atol=1e-12)
    np.testing.assert_allclose(momentum.sum(axis=0), (mass[:, None] * velocity).sum(axis=0), atol=1e-12)
    np.testing.assert_allclose(restored, velocity, atol=1e-12)
    np.testing.assert_allclose(gradient, np.broadcast_to(affine, gradient.shape), atol=1e-12)
    np.testing.assert_allclose(derivative, np.broadcast_to(affine, derivative.shape), atol=1e-12)


def test_apic_transfer_conserves_particle_orbital_and_affine_angular_momentum():
    points, mass = particle_cloud()
    rng = np.random.default_rng(451)
    velocity = rng.normal(size=points.shape)
    affine = rng.normal(size=(len(points), 3, 3))
    grid_mass, momentum, prepared = particle_to_grid(points, velocity, affine, mass, np.zeros(3), 0.1, (11, 11, 11))
    grid_positions = np.stack(np.meshgrid(*[np.arange(11) * 0.1] * 3, indexing="ij"), axis=-1).reshape(-1, 3)
    angular = np.cross(points, mass[:, None] * velocity).sum(axis=0)
    angular += (mass[:, None] * 0.1**2 / 4 * np.column_stack((affine[:, 2, 1] - affine[:, 1, 2], affine[:, 0, 2] - affine[:, 2, 0], affine[:, 1, 0] - affine[:, 0, 1]))).sum(axis=0)
    np.testing.assert_allclose(np.cross(grid_positions, momentum).sum(axis=0), angular, atol=1e-12)


def test_neo_hookean_stress_is_energy_derivative_and_frame_indifferent():
    deformation = np.array([[1.12, 0.13, 0.0], [0.02, 0.91, 0.03], [0.01, 0.0, 1.04]])
    stress, piola, energy = neo_hookean(deformation, 80.0, 110.0)
    difference = np.zeros((3, 3))
    for row in range(3):
        for column in range(3):
            increment = np.zeros((3, 3))
            increment[row, column] = 1e-6
            difference[row, column] = (neo_hookean(deformation + increment, 80.0, 110.0)[2] - neo_hookean(deformation - increment, 80.0, 110.0)[2]) / 2e-6
    np.testing.assert_allclose(piola, difference, atol=1e-7, rtol=1e-7)
    angle = 0.4
    rotation = np.array([[np.cos(angle), -np.sin(angle), 0], [np.sin(angle), np.cos(angle), 0], [0, 0, 1]])
    rotated_stress, _, rotated_energy = neo_hookean(rotation @ deformation, 80.0, 110.0)
    np.testing.assert_allclose(rotated_stress, rotation @ stress @ rotation.T, atol=1e-12)
    assert rotated_energy == pytest.approx(energy, abs=1e-12)
    np.testing.assert_allclose(neo_hookean(rotation, 80.0, 110.0)[0], 0, atol=1e-12)


@pytest.mark.parametrize("stretch", [0.8, 1.2])
def test_uniaxial_stretch_has_independent_analytic_stress(stretch):
    deformation = np.diag([stretch, 1.0, 1.0])
    stress, _, energy = neo_hookean(deformation, 50.0, 70.0)
    expected = np.diag([(50 * (stretch**2 - 1) + 70 * np.log(stretch)) / stretch, 70 * np.log(stretch) / stretch, 70 * np.log(stretch) / stretch])
    np.testing.assert_allclose(stress, expected, atol=1e-12)
    assert energy > 0


def test_mpm_free_fall_and_failed_trial_preserve_inputs():
    points, mass = particle_cloud()
    deformation = np.broadcast_to(np.eye(3), (len(points), 3, 3)).copy()
    velocity, affine = np.zeros_like(points), np.zeros_like(deformation)
    settings = {"origin": np.zeros(3), "spacing": 0.1, "shape": (11, 11, 11), "density": 1000.0, "shear": 1000.0, "lame": 1000.0, "gravity": np.array([0.0, -9.81, 0.0])}
    dt = min(0.001, stable_timestep(velocity, settings))
    moved, speed, gradient, _ = step(points, velocity, deformation, affine, mass, mass / 1000, settings, dt)
    np.testing.assert_allclose(speed, np.broadcast_to([0, -9.81 * dt, 0], speed.shape), atol=1e-12)
    np.testing.assert_allclose(gradient, deformation, atol=1e-12)
    np.testing.assert_allclose(moved, points + dt * speed, atol=1e-12)
    invalid = deformation.copy()
    invalid[0, 0, 0] = -1
    before = points.copy(), velocity.copy(), invalid.copy(), affine.copy()
    with pytest.raises(ValueError, match="positive J"):
        step(points, velocity, invalid, affine, mass, mass / 1000, settings, dt)
    for actual, original in zip((points, velocity, invalid, affine), before):
        np.testing.assert_array_equal(actual, original)


def test_fixed_grid_support_is_rejected_before_trial_returns():
    points, mass = particle_cloud()
    count = len(points)
    settings = {"origin": np.zeros(3), "spacing": 0.1, "shape": (11, 11, 11), "density": 1000.0, "shear": 10.0, "lame": 10.0, "gravity": np.zeros(3)}
    with pytest.raises(ValueError, match="support left"):
        step(points, np.full_like(points, 100.0), np.broadcast_to(np.eye(3), (count, 3, 3)), np.zeros((count, 3, 3)), mass, mass / 1000, settings, 1.0)


def test_mpm_transfer_and_step_are_independent_of_particle_row_order():
    points, mass = particle_cloud()
    rng = np.random.default_rng(87)
    order = rng.permutation(len(points))
    reverse = np.argsort(order)
    velocity = rng.normal(0, .01, points.shape)
    deformation = np.broadcast_to(np.eye(3), (len(points), 3, 3)).copy()
    affine = rng.normal(0, .01, deformation.shape)
    settings = {"origin": np.zeros(3), "spacing": .1, "shape": (11, 11, 11), "density": 1000.,
                "shear": 100., "lame": 100., "gravity": np.array([0., -.1, 0.])}
    baseline = step(points, velocity, deformation, affine, mass, mass / 1000, settings, .001)
    reordered = step(points[order], velocity[order], deformation[order], affine[order], mass[order], mass[order] / 1000, settings, .001)
    for actual, expected in zip(reordered, baseline):
        np.testing.assert_allclose(actual[reverse], expected, atol=1e-12, rtol=1e-12)


def test_elastic_compression_converges_with_timestep_refinement():
    positions = np.stack(np.meshgrid(*[np.arange(.325, .7, .05)] * 3, indexing="ij"), axis=-1).reshape(-1, 3)
    mass = np.full(len(positions), 1000 * .05**3)
    settings = {"origin": np.zeros(3), "spacing": .1, "shape": (11, 11, 11), "density": 1000.,
                "shear": 1000., "lame": 1000., "gravity": np.zeros(3)}

    def solve(dt):
        points = positions.copy()
        velocity = np.zeros_like(points)
        velocity[:, 1] = -.5 * (points[:, 1] - .5)
        affine = np.zeros((len(points), 3, 3))
        affine[:, 1, 1] = -.5
        deformation = np.broadcast_to(np.eye(3), affine.shape).copy()
        for _ in range(round(.04 / dt)):
            points, velocity, deformation, affine = step(points, velocity, deformation, affine, mass, mass / 1000, settings, dt)
        return points, deformation

    reference_position, reference_deformation = solve(.0003125)
    errors = []
    for dt in (.005, .0025, .00125):
        points, deformation = solve(dt)
        errors.append((np.linalg.norm(points - reference_position), np.linalg.norm(deformation - reference_deformation)))
    assert np.all(np.diff(np.asarray(errors), axis=0) < 0)
    assert errors[-1][1] / np.linalg.norm(reference_deformation - np.eye(3)) < .03


def test_fixed_base_gravity_displacement_converges_with_grid_refinement():
    displacements = []
    for spacing in (.1, .05, .025):
        particle_spacing = spacing / 2
        axis = .3 + (np.arange(round(.4 / particle_spacing)) + .5) * particle_spacing
        positions = np.stack(np.meshgrid(axis, axis, axis, indexing="ij"), axis=-1).reshape(-1, 3)
        initial = positions.copy()
        mass = np.full(len(positions), 1000 * particle_spacing**3)
        velocity, affine = np.zeros_like(positions), np.zeros((len(positions), 3, 3))
        deformation = np.broadcast_to(np.eye(3), affine.shape).copy()
        shape = (round(1 / spacing) + 1,) * 3
        nodes = np.stack(np.meshgrid(*[np.arange(shape[0]) * spacing] * 3, indexing="ij"), axis=-1).reshape(-1, 3)
        settings = {"origin": np.zeros(3), "spacing": spacing, "shape": shape, "density": 1000.,
                    "shear": 4000., "lame": 4000., "gravity": np.array([0., -.1, 0.]),
                    "fixedNodes": np.flatnonzero(nodes[:, 1] <= .3 + 1e-10)}
        for _ in range(20):
            positions, velocity, deformation, affine = step(positions, velocity, deformation, affine, mass, mass / 1000, settings, .001)
        assert np.min(positions[:, 1]) > .3
        displacements.append(float(np.mean(positions[:, 1] - initial[:, 1])))
        assert displacements[-1] < 0
    errors = np.abs((np.asarray(displacements[:-1]) - displacements[-1]) / displacements[-1])
    assert errors[1] < errors[0]
    assert errors[1] < .05
