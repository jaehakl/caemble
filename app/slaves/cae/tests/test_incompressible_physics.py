"""Independent steady Stokes references on skew tetrahedral control volumes."""

import asyncio
from itertools import combinations
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api.errors import CaeError
from app.kernel.coordinator.plan import detached
from app.kernel.coordinator.run import CaeRun
from app.methods.geometry import GeometryService
from app.methods.finite_volume.tetrahedral import create_fv_mesh
from app.solvers.incompressible_flow.domain import build_domain
from app.solvers.incompressible_flow.formulation import solve_stokes
from tests.test_incompressible_methods import tetrahedral_box


def pressure_duct_boundaries(mesh, pressure_drop=1.):
    boundary = mesh.neighbour < 0
    lower, upper = mesh.points[:, 0].min(), mesh.points[:, 0].max()
    inlet = boundary & np.isclose(mesh.face_centers[:, 0], lower)
    outlet = boundary & np.isclose(mesh.face_centers[:, 0], upper)
    velocity = np.full((len(mesh.faces), 3), np.nan)
    pressure = np.full(len(mesh.faces), np.nan)
    velocity[boundary & ~inlet & ~outlet] = 0
    pressure[inlet], pressure[outlet] = pressure_drop, 0
    return velocity, pressure, inlet, outlet


def rectangular_duct_reference(points, pressure_gradient=.5, viscosity=1., width=1., height=1.):
    odd = np.arange(1, 100, 2, dtype=float)
    m, n = odd[:, None], odd[None, :]
    wave_numbers = (m / width)**2 + (n / height)**2
    coefficients = 16 * pressure_gradient / (viscosity * np.pi**4 * m * n * wave_numbers)
    velocity = np.einsum("im,mn,in->i", np.sin(np.pi * points[:, 1, None] * odd / width),
                         coefficients, np.sin(np.pi * points[:, 2, None] * odd / height))
    flow_rate = 64 * pressure_gradient * width * height / (viscosity * np.pi**6) * np.sum(1 / (m**2 * n**2 * wave_numbers))
    return velocity, float(flow_rate)


def test_closed_irregular_domain_reproduces_hydrostatic_pressure_and_zero_flow():
    mesh = tetrahedral_box((3, 3, 3), (1.3, .7, 1.1))
    boundary_velocity = np.full((len(mesh.faces), 3), np.nan)
    boundary_velocity[mesh.neighbour < 0] = 0
    density, gravity = 997., np.array([.3, -.8, -9.81])
    solution = asyncio.run(solve_stokes(mesh, density, .001, gravity, boundary_velocity,
                                      np.full(len(mesh.faces), np.nan)))
    center = np.average(mesh.cell_centers, axis=0, weights=mesh.cell_volumes)
    expected = density * ((mesh.cell_centers - center) @ gravity)
    assert np.allclose(solution.pressure, expected, atol=1e-11)
    assert abs(np.average(solution.pressure, weights=mesh.cell_volumes)) < 1e-11
    assert np.array_equal(solution.velocity, np.zeros_like(solution.velocity))
    assert np.array_equal(solution.face_volume_flux, np.zeros_like(solution.face_volume_flux))
    assert solution.mass_residual == solution.momentum_residual == 0


def test_irregular_pressure_duct_converges_to_square_duct_reference():
    velocity_errors, pressure_errors, flow_errors = [], [], []
    for resolution in (3, 5, 8):
        mesh = tetrahedral_box((2 * resolution, resolution, resolution), (2., 1., 1.))
        boundary_velocity, boundary_pressure, inlet, outlet = pressure_duct_boundaries(mesh)
        solution = asyncio.run(solve_stokes(mesh, 1., 1., [0, 0, 0], boundary_velocity, boundary_pressure,
                                           tolerance=1e-11))
        exact_velocity, exact_flow = rectangular_duct_reference(mesh.cell_centers)
        exact_pressure = 1 - mesh.cell_centers[:, 0] / 2
        velocity_errors.append(float(np.sqrt(np.average((solution.velocity[:, 0] - exact_velocity)**2,
                                                        weights=mesh.cell_volumes))))
        pressure_errors.append(float(np.sqrt(np.average((solution.pressure - exact_pressure)**2,
                                                        weights=mesh.cell_volumes))))
        flow_errors.append(abs(float(solution.face_volume_flux[outlet].sum()) - exact_flow))
        assert solution.mass_residual < 1e-8
        assert solution.momentum_residual < 1e-8
        assert abs(solution.face_volume_flux[inlet].sum() + solution.face_volume_flux[outlet].sum()) < 1e-12
        walls = np.all(np.isfinite(boundary_velocity), axis=1)
        assert np.array_equal(solution.face_volume_flux[walls], np.zeros(np.count_nonzero(walls)))
    assert velocity_errors[2] < velocity_errors[1] < velocity_errors[0]
    assert pressure_errors[2] < pressure_errors[1] < pressure_errors[0]
    assert flow_errors[2] < flow_errors[1] < flow_errors[0]
    assert velocity_errors[2] < velocity_errors[0] * .3
    assert flow_errors[2] < flow_errors[0] * .3


def test_pressure_open_flux_reverses_without_changing_boundary_types():
    mesh = tetrahedral_box((6, 3, 3), (2., 1., 1.))
    results = []
    for pressure_drop in (1., -1.):
        velocity, pressure, inlet, outlet = pressure_duct_boundaries(mesh, pressure_drop)
        results.append(asyncio.run(solve_stokes(mesh, 1., 1., [0, 0, 0], velocity, pressure)))
    assert np.allclose(results[0].pressure, -results[1].pressure, atol=1e-11)
    assert np.allclose(results[0].velocity, -results[1].velocity, atol=1e-11)
    assert np.allclose(results[0].face_volume_flux, -results[1].face_volume_flux, atol=1e-11)
    assert results[0].face_volume_flux[inlet].sum() < 0 < results[0].face_volume_flux[outlet].sum()
    assert results[1].face_volume_flux[outlet].sum() < 0 < results[1].face_volume_flux[inlet].sum()


def test_uniform_pressure_shift_preserves_velocity_and_corrected_flux():
    mesh = tetrahedral_box((4, 2, 2), (2., 1., 1.))
    velocity, pressure, _, _ = pressure_duct_boundaries(mesh)
    first = asyncio.run(solve_stokes(mesh, 1., 1., [0, 0, 0], velocity, pressure))
    pressure[np.isfinite(pressure)] += 13.
    second = asyncio.run(solve_stokes(mesh, 1., 1., [0, 0, 0], velocity, pressure))
    assert np.allclose(second.pressure, first.pressure + 13., atol=1e-12)
    assert np.allclose(second.velocity, first.velocity, atol=1e-12)
    assert np.allclose(second.face_volume_flux, first.face_volume_flux, atol=1e-12)


def test_uniform_prescribed_velocity_preserves_exact_boundary_flux_and_mean_pressure():
    mesh = tetrahedral_box()
    prescribed = np.array([.3, -.2, .1])
    velocity = np.full((len(mesh.faces), 3), np.nan)
    boundary = mesh.neighbour < 0
    velocity[boundary] = prescribed
    result = asyncio.run(solve_stokes(mesh, 1., 1., [0, 0, 0], velocity, np.full(len(mesh.faces), np.nan)))
    assert np.allclose(result.velocity, prescribed, atol=2e-13)
    assert np.allclose(result.pressure, 0, atol=2e-13)
    assert np.allclose(result.face_volume_flux, mesh.area_vectors @ prescribed, atol=2e-14)
    assert np.array_equal(result.face_volume_flux[boundary], np.einsum("ij,j->i", mesh.area_vectors[boundary], prescribed))
    assert result.mass_residual < 1e-12


def test_stagnant_leaf_cell_has_zero_flux_without_a_relative_roundoff_failure():
    points = np.asarray([[0., 0, 0], [1., 0, 0], [0., 1, 0], [0., 0, 1], [1., 1, 1]])
    cells = np.asarray([[0, 1, 2, 3], [1, 2, 3, 4]])
    faces = np.asarray([face for cell in cells for face in combinations(cell, 3)])
    unique, counts = np.unique(np.sort(faces, axis=1), axis=0, return_counts=True)
    mesh = create_fv_mesh(points, cells, unique[counts == 1])
    velocity, pressure = np.full((len(mesh.faces), 3), np.nan), np.full(len(mesh.faces), np.nan)
    exterior = mesh.neighbour < 0
    velocity[exterior] = 0
    openings = exterior & (mesh.owner == 0) & ~np.isclose(mesh.face_centers[:, 0], 0)
    velocity[openings] = np.nan
    pressure[openings] = [1., 0.]
    result = asyncio.run(solve_stokes(mesh, 1., 1., [0, 0, 0], velocity, pressure, tolerance=1e-11))
    assert abs(result.face_volume_flux[mesh.neighbour >= 0][0]) < 1e-14
    assert result.mass_residual < 1e-11


@pytest.mark.asyncio
async def test_real_csg_catalog_duct_converges_with_full_nonorthogonal_flux(catalog_builds):
    run = CaeRun(measurement=catalog_builds["incompressible-stokes-duct"], max_run_seconds=180, job_id="stokes-physics")
    try:
        spec = run.plan.task_specs["flow"]
        invocation = SimpleNamespace(config=detached(spec.task["config"]), world=run.plan.world(spec),
                                     geometry=GeometryService(), progress=None, cancellation=None)
        domain = await build_domain(invocation)
        progress = []

        async def report(value):
            if value["stage"] == "stokes-iteration":
                progress.append(value["completed"])

        solution = await solve_stokes(domain.mesh, domain.density, domain.viscosity, domain.gravity,
                                      domain.boundary_velocity, domain.boundary_pressure, progress=report)
        assert domain.mesh.maximum_nonorthogonality > 60
        assert solution.mass_residual <= 1e-8
        assert solution.momentum_residual <= 1e-8
        assert solution.pressure_residual <= 1e-8
        assert progress == list(range(solution.iterations + 1))
        assert solution.iterations <= 1000
        open_faces = np.isfinite(domain.boundary_pressure)
        inlet = open_faces & (domain.boundary_pressure == domain.boundary_pressure[open_faces].max())
        outlet = open_faces & ~inlet
        inlet_flow, outlet_flow = solution.face_volume_flux[inlet].sum(), solution.face_volume_flux[outlet].sum()
        assert inlet_flow < 0 < outlet_flow
        assert abs(inlet_flow + outlet_flow) < 1e-6 * outlet_flow
        lower = domain.mesh.points.min(axis=0)
        length, width, height = np.ptp(domain.mesh.points, axis=0)
        inlet_pressure = float(domain.boundary_pressure[inlet][0])
        outlet_pressure = float(domain.boundary_pressure[outlet][0])
        pressure_gradient = (inlet_pressure - outlet_pressure) / length
        points = domain.mesh.cell_centers - lower
        exact_velocity, exact_flow = rectangular_duct_reference(points, pressure_gradient, domain.viscosity, width, height)
        exact_pressure = inlet_pressure - pressure_gradient * points[:, 0]
        volume = domain.mesh.cell_volumes
        velocity_scale = np.sqrt(np.average(exact_velocity**2, weights=volume))
        # The official coarse CSG mesh is independently bounded; the refined
        # irregular-mesh test above separately checks decreasing spatial error.
        velocity_error = np.sqrt(np.average((solution.velocity[:, 0] - exact_velocity)**2, weights=volume)) / velocity_scale
        pressure_error = np.sqrt(np.average((solution.pressure - exact_pressure)**2, weights=volume)) / (inlet_pressure - outlet_pressure)
        assert velocity_error < .05
        assert pressure_error < .01
        assert abs(outlet_flow - exact_flow) / exact_flow < .10
    finally:
        await run.close()


def test_stokes_result_is_independent_of_tetrahedral_order_and_initial_checkerboard():
    first_mesh = tetrahedral_box((4, 2, 2), (2., 1., 1.))
    order = np.random.default_rng(17).permutation(len(first_mesh.cells))
    second_mesh = create_fv_mesh(first_mesh.points, first_mesh.cells[order][:, ::-1],
                                first_mesh.faces[first_mesh.boundary_face_map][::-1, ::-1])
    results = []
    for mesh in (first_mesh, second_mesh):
        velocity, pressure, _, _ = pressure_duct_boundaries(mesh)
        initial = np.where(np.arange(len(mesh.cells)) % 2, .3, -.3)
        results.append(asyncio.run(solve_stokes(mesh, 1., 1., [0, 0, 0], velocity, pressure,
                                              initial_pressure=initial, tolerance=1e-11)))
    assert np.allclose(results[0].pressure[order], results[1].pressure, atol=1e-8)
    assert np.allclose(results[0].velocity[order], results[1].velocity, atol=1e-9)


def test_unconverged_stokes_candidate_is_not_returned():
    mesh = tetrahedral_box((3, 2, 2), (2., 1., 1.))
    velocity, pressure, _, _ = pressure_duct_boundaries(mesh)
    with pytest.raises(CaeError, match="did not converge in 1 iterations"):
        asyncio.run(solve_stokes(mesh, 1., 1., [0, 0, 0], velocity, pressure, max_iterations=1))


def test_pressure_iteration_cancellation_preserves_initial_pressure_and_progress():
    mesh = tetrahedral_box((3, 2, 2), (2., 1., 1.))
    velocity, pressure, _, _ = pressure_duct_boundaries(mesh)
    initial = np.where(np.arange(len(mesh.cells)) % 2, .3, -.3)
    before = initial.copy()
    events = []

    def check_cancelled():
        if len(events) >= 3:
            raise asyncio.CancelledError

    async def progress(event):
        assert event["stage"] == "stokes-iteration"
        events.append(event["completed"])

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(solve_stokes(mesh, 1., 1., [0, 0, 0], velocity, pressure,
            initial_pressure=initial, cancellation=SimpleNamespace(raise_if_cancelled=check_cancelled), progress=progress))
    assert events == [0, 1, 2]
    np.testing.assert_array_equal(initial, before)


def test_driven_closed_cavity_pressure_has_zero_mean_independent_of_initial_gauge():
    mesh = tetrahedral_box((3, 3, 3))
    boundary = mesh.neighbour < 0
    velocity = np.full((mesh.face_count, 3), np.nan)
    velocity[boundary] = 0.
    velocity[boundary & np.isclose(mesh.face_centers[:, 2], 1.), 0] = 1.
    pressure = np.full(mesh.face_count, np.nan)
    initial = np.where(np.arange(len(mesh.cells)) % 2, .3, -.3)
    results = [asyncio.run(solve_stokes(mesh, 1., 1., [0, 0, 0], velocity, pressure,
        initial_pressure=initial + offset, tolerance=1e-10)) for offset in (0., 17.)]
    for result in results:
        assert result.iterations > 0
        assert np.linalg.norm(result.velocity) > .1
        assert abs(np.average(result.pressure, weights=mesh.cell_volumes)) < 1e-13
        assert max(result.mass_residual, result.momentum_residual, result.pressure_residual) <= 1e-10
    np.testing.assert_allclose(results[1].pressure, results[0].pressure, rtol=0., atol=1e-9)
    np.testing.assert_allclose(results[1].velocity, results[0].velocity, rtol=0., atol=1e-10)
    np.testing.assert_allclose(results[1].face_volume_flux, results[0].face_volume_flux, rtol=0., atol=1e-11)
