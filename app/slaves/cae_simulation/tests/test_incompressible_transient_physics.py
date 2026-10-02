"""Independent transient references and accepted-state numerical boundaries."""

from types import SimpleNamespace

import numpy as np
import pytest
from numpy.polynomial.legendre import leggauss
from scipy import sparse
from scipy.sparse.linalg import splu

from app.kernel.coordinator.plan import detached
from app.kernel.coordinator.run import CaeRun
from app.methods.finite_element.tetrahedron import tetrahedron_quadrature
from app.methods.finite_volume.tetrahedral import cell_operators
from app.methods.geometry import GeometryService
from app.solvers.incompressible_flow.domain import build_domain
from app.solvers.incompressible_flow.linear import LinearFlowSystem, TransientPressureInverse
from app.solvers.incompressible_flow.transient import PreparedTransientFlow, TransientStepFailure
from tests.flow_fixtures import tetrahedral_box
from tests.flow_fixtures import pressure_duct_boundaries


def startup_reference(points, time, viscosity=1., density=1.):
    odd = np.arange(1, 100, 2, dtype=float)
    m, n = odd[:, None], odd[None, :]
    eigenvalue = np.pi**2 * (m**2 + n**2)
    coefficient = 8 / (viscosity * np.pi**2 * m * n * eigenvalue)
    coefficient *= -np.expm1(-viscosity / density * eigenvalue * time)
    velocity = np.einsum("im,mn,in->i", np.sin(np.pi * points[:, 1, None] * odd),
                         coefficient, np.sin(np.pi * points[:, 2, None] * odd))
    flow = np.sum(coefficient * 4 / (np.pi**2 * m * n))
    return velocity, float(flow)


def shear_problem(resolution):
    mesh = tetrahedral_box((resolution, resolution, resolution))
    barycentric, weights = tetrahedron_quadrature(6)
    cell_x = np.einsum("qv,cv->cq", barycentric, mesh.points[mesh.cells, 0])
    cell_phase = np.exp(2j * np.pi * cell_x) @ (6 * weights)
    ticks, weights = leggauss(8)
    ticks, weights = (ticks + 1) / 2, weights / 2
    a, b = np.meshgrid(ticks, ticks, indexing="ij")
    face_barycentric = np.stack([a, (1-a)*b, (1-a)*(1-b)], axis=-1).reshape(-1, 3)
    face_weights = (2 * np.outer(weights, weights) * (1-a)).ravel()
    face_x = np.einsum("qv,fv->fq", face_barycentric, mesh.points[mesh.faces, 0])
    face_phase = np.exp(2j * np.pi * face_x) @ face_weights

    def reference(time):
        phase = .1 * np.exp(-.02 * (2 * np.pi)**2 * time - 2j * np.pi * time)
        velocity = np.column_stack([np.ones(len(mesh.cells)), np.imag(phase * cell_phase), np.zeros(len(mesh.cells))])
        face_velocity = np.column_stack([np.ones(len(mesh.faces)), np.imag(phase * face_phase), np.zeros(len(mesh.faces))])
        boundary_velocity = np.where((mesh.neighbour < 0)[:, None], face_velocity, np.nan)
        flux = np.einsum("ij,ij->i", face_velocity, mesh.area_vectors)
        return SimpleNamespace(pressure=np.zeros(len(mesh.cells)), velocity=velocity, face_volume_flux=flux), boundary_velocity

    initial, boundary = reference(0.)
    solver = PreparedTransientFlow(mesh, 1., .02, [0, 0, 0], boundary, np.full(len(mesh.faces), np.nan))
    return solver, reference, initial


async def integrate(solver, initial, dt, count, reference=None):
    state = initial
    for index in range(count):
        arguments = {}
        if reference is not None:
            _, previous = reference(index * dt)
            _, boundary = reference((index + 1) * dt)
            arguments = {"boundary_velocity": boundary, "previous_boundary_velocity": previous}
        state = await solver.step(pressure=state.pressure, velocity=state.velocity, face_volume_flux=state.face_volume_flux,
                                  dt=dt, time=index * dt, tolerance=1e-10, **arguments)
    return state


@pytest.mark.asyncio
async def test_rest_initialization_preserves_startup_and_sets_pressure_acceleration_constraint():
    mesh = tetrahedral_box((4, 2, 2), (2., 1., 1.))
    velocity, pressure, _, _ = pressure_duct_boundaries(mesh)
    solver = PreparedTransientFlow(mesh, 1., 1., [0, 0, 0], velocity, pressure)
    initial = await solver.initialize(tolerance=1e-11)
    assert np.array_equal(initial.velocity, np.zeros_like(initial.velocity))
    assert np.array_equal(initial.face_volume_flux, np.zeros_like(initial.face_volume_flux))
    assert np.allclose(initial.pressure, 1 - mesh.cell_centers[:, 0] / 2, atol=3e-14)


@pytest.mark.asyncio
async def test_nonzero_inlet_initialization_projects_velocity_and_flux_together():
    mesh = tetrahedral_box((4, 2, 2), (2., 1., 1.))
    velocity, pressure, inlet, outlet = pressure_duct_boundaries(mesh)
    pressure[inlet] = np.nan
    velocity[inlet] = [1., 0, 0]
    solver = PreparedTransientFlow(mesh, 1., 1., [0, 0, 0], velocity, pressure)
    initial = await solver.initialize(tolerance=1e-10)
    assert np.allclose(initial.velocity, [1., 0, 0], atol=1e-13)
    assert initial.face_volume_flux[inlet].sum() == pytest.approx(-1, abs=1e-14)
    assert initial.face_volume_flux[outlet].sum() == pytest.approx(1, abs=1e-14)
    assert initial.mass_residual < 1e-12


@pytest.mark.validation
@pytest.mark.asyncio
async def test_startup_duct_time_convergence_and_independent_series():
    mesh = tetrahedral_box((8, 4, 4), (2., 1., 1.))
    velocity, pressure, inlet, outlet = pressure_duct_boundaries(mesh)
    solver = PreparedTransientFlow(mesh, 1., 1., [0, 0, 0], velocity, pressure)
    initial = await solver.initialize()
    solutions = [await integrate(solver, initial, .08 / count, count) for count in (4, 8, 16)]
    differences = [np.linalg.norm(a.velocity-b.velocity) for a, b in zip(solutions, solutions[1:])]
    assert 1.6 < differences[0] / differences[1] < 2.4
    exact_velocity, exact_flow = startup_reference(mesh.cell_centers, .08)
    finest = solutions[-1]
    relative = np.sqrt(np.average((finest.velocity[:, 0]-exact_velocity)**2, weights=mesh.cell_volumes)
                       / np.average(exact_velocity**2, weights=mesh.cell_volumes))
    assert relative < .12
    assert abs(finest.face_volume_flux[outlet].sum()-exact_flow) / exact_flow < .15
    assert abs(finest.face_volume_flux[inlet].sum()+finest.face_volume_flux[outlet].sum()) < 1e-12


@pytest.mark.validation
@pytest.mark.asyncio
async def test_traveling_shear_advects_phase_and_converges_in_time():
    solver, reference, initial = shear_problem(4)
    solutions = [await integrate(solver, initial, .1 / count, count, reference) for count in (5, 10, 20)]
    differences = [np.linalg.norm(a.velocity-b.velocity) for a, b in zip(solutions, solutions[1:])]
    assert 1.6 < differences[0] / differences[1] < 2.4
    exact, _ = reference(.1)
    stationary, _ = reference(0.)
    advected_error = np.linalg.norm(solutions[-1].velocity - exact.velocity)
    untranslated = stationary.velocity.copy()
    untranslated[:, 1] *= np.exp(-.02 * (2*np.pi)**2 * .1)
    assert advected_error < np.linalg.norm(solutions[-1].velocity - untranslated) * .7
    assert solutions[-1].momentum_residual < 1e-10


@pytest.mark.validation
@pytest.mark.asyncio
async def test_startup_duct_spatial_refinement_approaches_independent_series():
    errors = []
    for resolution in (2, 3, 5):
        mesh = tetrahedral_box((2*resolution, resolution, resolution), (2., 1., 1.))
        velocity, pressure, inlet, outlet = pressure_duct_boundaries(mesh)
        solver = PreparedTransientFlow(mesh, 1., 1., [0, 0, 0], velocity, pressure)
        result = await integrate(solver, await solver.initialize(), .002, 40)
        exact, exact_flow = startup_reference(mesh.cell_centers, .08)
        velocity_error = np.sqrt(np.average((result.velocity[:, 0]-exact)**2, weights=mesh.cell_volumes)
                                 / np.average(exact**2, weights=mesh.cell_volumes))
        flow_error = abs(result.face_volume_flux[outlet].sum()-exact_flow) / exact_flow
        errors.append((velocity_error, flow_error))
        assert abs(result.face_volume_flux[inlet].sum()+result.face_volume_flux[outlet].sum()) < 1e-12
    errors = np.asarray(errors)
    assert np.all(errors[1:] < errors[:-1])
    assert np.all(np.log(errors[-2]/errors[-1])/np.log(5/3) > 1.)
    assert errors[-1, 0] < .05
    assert errors[-1, 1] < .08


@pytest.mark.validation
@pytest.mark.asyncio
async def test_traveling_shear_spatial_refinement_recovers_phase_and_decay():
    errors = []
    final_time = .05
    exact_phase = 2*np.pi*final_time
    exact_amplitude = .1*np.exp(-.02*(2*np.pi)**2*final_time)
    for resolution in (3, 4, 6):
        solver, reference, initial = shear_problem(resolution)
        result = await integrate(solver, initial, .001, 50, reference)
        exact, _ = reference(final_time)
        quarter_period, _ = reference(.25)
        # Cell averages of sin/cos form an independent amplitude/phase fit.
        sine = initial.velocity[:, 1]/.1
        cosine = -quarter_period.velocity[:, 1]/(.1*np.exp(-.02*(2*np.pi)**2*.25))
        basis = np.column_stack([sine, cosine])
        coefficients = np.linalg.lstsq(basis, result.velocity[:, 1], rcond=None)[0]
        phase = np.arctan2(-coefficients[1], coefficients[0])
        amplitude = np.linalg.norm(coefficients)
        velocity_error = np.sqrt(np.average((result.velocity[:, 1]-exact.velocity[:, 1])**2,
                                            weights=solver.mesh.cell_volumes))
        errors.append((velocity_error, abs(phase-exact_phase), abs(amplitude-exact_amplitude)))
        assert result.mass_residual < 1e-10
        assert result.momentum_residual < 1e-10
        assert abs(np.sum(result.face_volume_flux[solver.mesh.neighbour < 0])) < 1e-12
    errors = np.asarray(errors)
    assert np.all(errors[1:] < errors[:-1])
    assert errors[-1, 0] < .0045
    assert errors[-1, 1] < .006
    assert errors[-1, 2]/exact_amplitude < .04


@pytest.mark.asyncio
async def test_corrected_face_history_has_a_continuous_small_timestep_limit():
    solver, reference, initial = shear_problem(3)
    changes = []
    for dt in (1e-3, 1e-4, 1e-5):
        _, boundary = reference(dt)
        result = await solver.step(pressure=initial.pressure, velocity=initial.velocity,
                                   face_volume_flux=initial.face_volume_flux, dt=dt, tolerance=1e-10,
                                   boundary_velocity=boundary)
        changes.append(np.linalg.norm(result.face_volume_flux-initial.face_volume_flux))
        assert result.mass_residual < 1e-10
    # Without the old corrected face flux in Rhie--Chow, this difference has
    # a nonzero mesh-dependent limit even when the time increment tends to zero.
    assert np.all(np.asarray(changes[:-1])/changes[1:] > 9.5)
    assert np.all(np.asarray(changes[:-1])/changes[1:] < 10.5)


def test_pure_inertia_pressure_correction_has_no_skew_gradient_remainder():
    mesh = tetrahedral_box((3, 3, 3))
    velocity_values, pressure_values, _, _ = pressure_duct_boundaries(mesh, pressure_drop=0.)
    velocity_fixed = np.all(np.isfinite(velocity_values), axis=1)
    pressure_fixed = np.isfinite(pressure_values)
    velocity_operators = cell_operators(mesh, velocity_fixed)
    pressure_operators = cell_operators(mesh, pressure_fixed)
    density, dt = 1.7, .013
    system = LinearFlowSystem(mesh, velocity_operators, pressure_operators,
        sparse.diags(density*mesh.cell_volumes/dt), np.zeros((len(mesh.cells), 3)),
        velocity_fixed, pressure_fixed, np.nan_to_num(velocity_values), np.nan_to_num(pressure_values),
        reference_speed=1., force_density_scale=1.)
    checkerboard = np.where(np.arange(len(mesh.cells)) % 2, 1., -1.)
    _, corrected_flux, _ = system.response(checkerboard)
    exact = -dt/density * (pressure_operators.normal_gradient @ checkerboard)
    np.testing.assert_allclose(corrected_flux, exact, rtol=2e-14, atol=2e-16)


@pytest.mark.asyncio
async def test_transient_pressure_inverse_is_exact_in_the_pure_inertia_limit():
    mesh = tetrahedral_box((3, 3, 3))
    velocity_fixed, pressure_fixed = mesh.neighbour < 0, np.zeros(mesh.face_count, dtype=bool)
    velocity_operators, pressure_operators = cell_operators(mesh, velocity_fixed), cell_operators(mesh, pressure_fixed)
    density, dt = 1.7, .013
    free = np.arange(1, len(mesh.cells))
    laplacian = (-mesh.divergence @ pressure_operators.normal_gradient).tocsr()
    inverse = TransientPressureInverse(splu(laplacian[free][:, free].tocsc()), mesh.cell_volumes[free], density/dt, 0.)
    velocity = np.random.default_rng(94).normal(size=(len(mesh.cells), 3))
    mass = density*mesh.cell_volumes/dt
    system = LinearFlowSystem(mesh, velocity_operators, pressure_operators,
        sparse.diags(mass), mass[:, None]*velocity, velocity_fixed, pressure_fixed,
        np.zeros((mesh.face_count, 3)), np.zeros(mesh.face_count), reference_speed=1.,
        force_density_scale=density/dt, pressure_factor=inverse)
    result = await system.solve(max_iterations=1, tolerance=1e-10)
    assert result.iterations == 1
    assert result.mass_residual < 1e-10 and result.pressure_residual < 1e-10
    assert np.average(result.pressure, weights=mesh.cell_volumes) == pytest.approx(0., abs=2e-14)


@pytest.mark.validation
@pytest.mark.asyncio
async def test_actual_csg_startup_stays_bounded_and_matches_independent_series(catalog_builds):
    run = CaeRun(measurement=catalog_builds["incompressible-startup-channel"],
                 max_run_seconds=180, job_id="transient-flow-physics")
    try:
        spec = run.plan.task_specs["flow"]
        invocation = SimpleNamespace(config=detached(spec.task["config"]), world=run.plan.world(spec),
                                     geometry=GeometryService(), progress=None, cancellation=None)
        domain = await build_domain(invocation)
        mesh = domain.mesh
        solver = PreparedTransientFlow(mesh, domain.density, domain.viscosity, domain.gravity,
                                       domain.boundary_velocity, domain.boundary_pressure)
        result = await solver.initialize()
        assert mesh.maximum_nonorthogonality > 60
        for index in range(10):
            result = await solver.step(pressure=result.pressure, velocity=result.velocity,
                                       face_volume_flux=result.face_volume_flux, dt=.001, time=.001*index)
            assert result.mass_residual <= 1e-8
            assert result.momentum_residual <= 1e-8
            assert np.ptp(result.pressure) < .11
        lower = mesh.points.min(axis=0)
        length, width, height = np.ptp(mesh.points, axis=0)
        assert width == pytest.approx(height)
        opening = np.isfinite(domain.boundary_pressure)
        inlet = opening & (domain.boundary_pressure == domain.boundary_pressure[opening].max())
        outlet = opening & ~inlet
        inlet_pressure, outlet_pressure = domain.boundary_pressure[inlet][0], domain.boundary_pressure[outlet][0]
        pressure_gradient = (inlet_pressure-outlet_pressure)/length
        diffusion_time = domain.viscosity*.01/(domain.density*width**2)
        exact_velocity, exact_flow = startup_reference((mesh.cell_centers-lower)/width, diffusion_time)
        velocity_scale = 2*pressure_gradient*width**2/domain.viscosity
        exact_velocity *= velocity_scale
        exact_flow *= velocity_scale*width**2
        exact_pressure = inlet_pressure-pressure_gradient*(mesh.cell_centers[:, 0]-lower[0])
        velocity_error = np.sqrt(np.average((result.velocity[:, 0]-exact_velocity)**2, weights=mesh.cell_volumes)
                                 / np.average(exact_velocity**2, weights=mesh.cell_volumes))
        pressure_error = np.linalg.norm(result.pressure-exact_pressure)/np.linalg.norm(exact_pressure)
        assert velocity_error < .03
        assert pressure_error < .012
        assert abs(result.face_volume_flux[outlet].sum()-exact_flow)/exact_flow < .05
        assert abs(result.face_volume_flux[inlet].sum()+result.face_volume_flux[outlet].sum()) < 1e-12
    finally:
        await run.close()


@pytest.mark.asyncio
async def test_transient_reversal_hydrostatics_and_failed_candidate_preserve_input():
    mesh = tetrahedral_box((4, 2, 2), (2., 1., 1.))
    velocity, pressure, _, _ = pressure_duct_boundaries(mesh)
    solver = PreparedTransientFlow(mesh, 1., 1., [0, 0, 0], velocity, pressure)
    initial = await solver.initialize()
    copies = tuple(array.copy() for array in (initial.pressure, initial.velocity, initial.face_volume_flux))
    with pytest.raises(TransientStepFailure, match="nonlinear iterations") as failure:
        await solver.step(pressure=initial.pressure, velocity=initial.velocity, face_volume_flux=initial.face_volume_flux,
                          dt=.01, time=.25, max_nonlinear_iterations=1)
    assert failure.value.time == .26
    assert failure.value.iterations > 0
    assert all(f"{name}=" in str(failure.value) for name in ("mass", "momentum", "pressure", "flux"))
    for value, saved in zip((initial.pressure, initial.velocity, initial.face_volume_flux), copies):
        assert np.array_equal(value, saved)
    first = await integrate(solver, initial, .01, 2)
    reverse = PreparedTransientFlow(mesh, 1., 1., [0, 0, 0], velocity, -pressure)
    second = await integrate(reverse, await reverse.initialize(), .01, 2)
    assert np.allclose(first.face_volume_flux, -second.face_volume_flux, atol=1e-6)
    walls = np.full((len(mesh.faces), 3), np.nan)
    walls[mesh.neighbour < 0] = 0
    closed = PreparedTransientFlow(mesh, 1000., .001, [0, 0, -9.81], walls, np.full(len(mesh.faces), np.nan))
    hydro = await closed.initialize()
    evolved = await integrate(closed, hydro, .03, 3)
    assert np.array_equal(evolved.velocity, hydro.velocity)
    assert np.array_equal(evolved.face_volume_flux, hydro.face_volume_flux)
    assert np.array_equal(evolved.pressure, hydro.pressure)
