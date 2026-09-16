"""Independent wall loads, momentum balance and Boolean-obstacle buoyancy."""

from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api import ContentKey
from app.methods.finite_volume.tetrahedral import upwind_convection
from app.solvers.incompressible_flow.domain import build_domain
from app.solvers.incompressible_flow.formulation import solve_stokes
from app.solvers.incompressible_flow.periodic import boundary_patches, split_gravity
from app.solvers.incompressible_flow.surface_loads import SurfaceBoxOverlap, SurfaceRecovery
from app.solvers.incompressible_flow.transient import PreparedTransientFlow
from tests.test_incompressible_domain import fluid_invocation
from tests.test_incompressible_outputs import observation
from tests.test_incompressible_periodic import closed_boundaries, periodic_box


def channel_domain(resolution):
    _, _, mesh = periodic_box((4, 3, resolution))
    velocity, pressure = closed_boundaries(mesh)
    gravity = np.array([1., 0., 0.])
    hydro, drive = split_gravity(mesh, gravity)
    centers = mesh.physical_face_centers[mesh.boundary_face_map]
    roles = np.full(len(mesh.boundary_face_map), "periodic", dtype=object)
    roles[np.isclose(centers[:, 2], 0.) | np.isclose(centers[:, 2], 1.)] = "wall"
    return SimpleNamespace(mesh=mesh, density=1., viscosity=1., gravity=gravity,
        boundary_velocity=velocity, boundary_pressure=pressure, boundary_roles=roles,
        boundary_patches=boundary_patches(mesh), metadata={
            "pressureReferencePoint": np.average(mesh.cell_centers, axis=0, weights=mesh.cell_volumes),
            "hydrostaticGravity": hydro, "drivingAcceleration": drive})


@pytest.mark.asyncio
async def test_channel_wall_force_moment_and_traction_converge_independently():
    errors = []
    origin = np.array([-.2, .3, -.4])
    for resolution in (3, 5, 8):
        domain = channel_domain(resolution)
        mesh = domain.mesh
        result = await solve_stokes(mesh, domain.density, domain.viscosity, domain.gravity,
            domain.boundary_velocity, domain.boundary_pressure, tolerance=1e-10)
        trace = SurfaceRecovery(domain).trace(result.pressure, result.velocity)
        grid = observation((1, 1, 1), (-.1, -.1, -.1), (2.2, 1.2, 1.2))
        walls = np.flatnonzero(domain.boundary_roles == "wall")
        selected = SurfaceBoxOverlap.prepare(domain, walls, grid)
        traction = trace.traction(contribution="viscous")[selected.boundaries]
        exact_traction = np.array([.5, 0., 0.])
        traction_error = np.sqrt(np.average(np.sum((traction-exact_traction)**2, axis=1),
                                             weights=selected.areas)) / .5
        force_error, moment_error = 0., 0.
        for side in (0., 1.):
            boundaries = walls[np.isclose(mesh.physical_face_centers[mesh.boundary_face_map[walls], 2], side)]
            surface = SurfaceBoxOverlap.prepare(domain, boundaries, grid)
            force = surface.force_moment(trace, 0., "viscous")
            moment = surface.force_moment(trace, 0., "viscous", origin)
            exact_force = np.array([1., 0., 0.])  # wall area 2, shear stress 1/2
            exact_moment = np.cross(np.array([1., .5, side])-origin, exact_force)
            force_error = max(force_error, np.linalg.norm(force-exact_force))
            moment_error = max(moment_error, np.linalg.norm(moment-exact_moment))
        errors.append([traction_error, force_error, moment_error])
        assert result.mass_residual < 1e-10 and result.momentum_residual < 1e-10
    errors = np.asarray(errors)
    print("steady wall traction/force/moment errors", errors.tolist())
    assert np.all(np.diff(errors, axis=0) < 0)
    assert errors[-1, 0] < .015
    assert errors[-1, 1] < .005
    assert errors[-1, 2] < .006


@pytest.mark.asyncio
async def test_startup_global_momentum_budget_separates_residual_and_surface_error():
    dt, count = .002, 20
    odd = np.arange(1, 2000, 2, dtype=float)
    # Exact eigenfunctions with backward-Euler modal decay remove time error
    # from the spatial wall-load comparison. The continuous series is separate.
    discrete_force = 4*(.5-4/np.pi**2*np.sum((1+dt*(np.pi*odd)**2)**(-count)/odd**2))
    continuous_force = 4*(.5-4/np.pi**2*np.sum(np.exp(-dt*count*(np.pi*odd)**2)/odd**2))
    assert abs(discrete_force-continuous_force)/continuous_force < .01
    errors = []
    for resolution in (3, 5, 8):
        domain = channel_domain(resolution)
        mesh = domain.mesh
        prepared = PreparedTransientFlow(mesh, domain.density, domain.viscosity, domain.gravity,
                                         domain.boundary_velocity, domain.boundary_pressure)
        state = await prepared.initialize(tolerance=1e-10)
        for index in range(count):
            previous = state
            state = await prepared.step(pressure=state.pressure, velocity=state.velocity,
                face_volume_flux=state.face_volume_flux, dt=dt, time=index*dt, tolerance=1e-10)
        values = np.nan_to_num(domain.boundary_velocity)
        pressure_values = np.zeros(mesh.face_count)
        convection, convection_boundary = upwind_convection(mesh, state.face_volume_flux, prepared.velocity_operators)
        inertia = domain.density*mesh.cell_volumes[:, None]*(state.velocity-previous.velocity)/dt
        diffusion = prepared.diffusion @ state.velocity-prepared.diffusion_boundary @ values
        advection = domain.density*(convection @ state.velocity+convection_boundary @ values)
        gradient = (prepared.pressure_operators.gauss_gradient @ state.pressure
                    + prepared.pressure_operators.gauss_gradient_boundary @ pressure_values).reshape(-1, 3)
        pressure_force = mesh.cell_volumes[:, None]*gradient
        balance = inertia+diffusion+advection+pressure_force-prepared.body_force
        body = prepared.body_force.sum(axis=0)
        # The FVM budget uses final corrected phi, with both periodic sides of
        # each common interface cancelling exactly in the global transport sum.
        assert np.linalg.norm(balance.sum(axis=0))/np.linalg.norm(body) < 1e-9
        np.testing.assert_allclose(advection.sum(axis=0), 0., atol=2e-14)
        assert state.mass_residual < 1e-10 and state.momentum_residual < 1e-10
        trace = SurfaceRecovery(domain).trace(state.pressure, state.velocity)
        walls = SurfaceBoxOverlap.prepare(domain, np.flatnonzero(domain.boundary_roles == "wall"),
            observation((1, 1, 1), (-.1, -.1, -.1), (2.2, 1.2, 1.2)))
        load = walls.force_moment(trace, 0., "total")
        recovered_budget = np.linalg.norm(inertia.sum(axis=0)+load-body)/np.linalg.norm(body)
        load_error = np.linalg.norm(load-[discrete_force, 0., 0.])/discrete_force
        errors.append([load_error, recovered_budget])
        # Surface stress is independently reconstructed; no load rebalance is
        # used to manufacture equality with the conserved momentum equation.
        assert recovered_budget < .005
    errors = np.asarray(errors)
    print("startup wall force error / recovered momentum budget", errors.tolist(),
          "analytic time error", abs(discrete_force-continuous_force)/continuous_force)
    assert np.all(np.diff(errors, axis=0) < 0)
    assert errors[-1, 0] < .02
    assert errors[-1, 1] < .002


@pytest.mark.asyncio
async def test_boolean_closed_obstacle_buoyancy_gauge_cancellation_and_surface_refinement():
    size = np.array([.35, .26, .22])
    center, origin = np.array([.08, -.06, .04]), np.array([-.4, .2, -.3])
    gravity = np.array([.7, -1.1, -2.3])
    angle = .37
    rotation = np.array([[np.cos(angle), -np.sin(angle), 0.], [np.sin(angle), np.cos(angle), 0.], [0., 0., 1.]])
    matrix = np.eye(4)
    matrix[:3, :3], matrix[:3, 3] = rotation, center
    errors = []
    for resolution in (.35, .24, .16):
        invocation = fluid_invocation()
        scene = invocation.world["experiment"]
        outer = scene["roots"][0]["node"]
        obstacle = {"kind": "transform", "nodeId": "obstacle-placement", "matrix": matrix.ravel().tolist(),
            "child": {"kind": "primitive", "nodeId": "obstacle", "primitive": "box", "parameters": {"size": size.tolist()}}}
        scene["roots"][0]["node"] = {"kind": "boolean", "nodeId": "fluid-minus-obstacle", "operation": "subtract",
                                        "children": [outer, obstacle]}
        scene["geometryHash"] = str(ContentKey.from_parts("buoyancy-obstacle", scene["roots"]))
        scene["surfaceGroups"].append({"name": "obstacle", "selectors": [
            {"rootId": "fluid", "sourceNodeId": "obstacle", "surfaceIndex": index} for index in range(6)]})
        invocation.config["parameters"].update(spatialResolution=resolution, gravity=gravity.tolist())
        domain = await build_domain(invocation)
        mesh = domain.mesh
        assert mesh.cell_volumes.sum() == pytest.approx(1.-np.prod(size), rel=2e-12)
        result = await solve_stokes(mesh, domain.density, domain.viscosity, gravity,
            domain.boundary_velocity, domain.boundary_pressure, tolerance=1e-10)
        np.testing.assert_allclose(result.velocity, 0., atol=1e-12)
        boundaries = domain.surface_regions["experiment.surface.obstacle"]
        assert len(boundaries) and np.all(domain.boundary_roles[boundaries] == "wall")
        surface = SurfaceBoxOverlap.prepare(domain, boundaries,
            observation((1, 1, 1), (-.6, -.6, -.6), (1.2, 1.2, 1.2)))
        recovery = SurfaceRecovery(domain)
        trace = recovery.trace(result.pressure, result.velocity)
        exact_force = -domain.density*np.prod(size)*gravity
        exact_moment = np.cross(center-origin, exact_force)
        force = surface.force_moment(trace, 0., "total")
        moment = surface.force_moment(trace, 0., "total", origin)
        np.testing.assert_allclose(force, exact_force, rtol=2e-12, atol=2e-10)
        np.testing.assert_array_equal(trace.viscous_traction, 0.)
        for pressure, offset in ((result.pressure, 137.), (result.pressure+137., 0.)):
            shifted = recovery.trace(pressure, result.velocity)
            np.testing.assert_allclose(surface.force_moment(shifted, offset, "total"), force, rtol=0, atol=2e-10)
            np.testing.assert_allclose(surface.force_moment(shifted, offset, "total", origin), moment, rtol=0, atol=2e-10)
        # One triangle carries constant traction. The exact affine hydrostatic
        # pressure variance is g^T Cov(triangle) g, Cov=sum((v-c)(v-c)^T)/12.
        triangles = mesh.points[mesh.faces[mesh.boundary_face_map[surface.boundaries]]]
        relative = triangles-triangles.mean(axis=1)[:, None, :]
        covariance = np.einsum("fvi,fvj->fij", relative, relative)/12
        pressure_variance = domain.density**2*np.einsum("i,fij,j->f", gravity, covariance, gravity)
        pressure_scale = domain.density*np.linalg.norm(gravity)*np.max(size)
        representation_error = np.sqrt(np.average(pressure_variance, weights=surface.areas))/pressure_scale
        moment_error = np.linalg.norm(moment-exact_moment)/np.linalg.norm(exact_moment)
        errors.append([representation_error, moment_error])
    errors = np.asarray(errors)
    print("Boolean obstacle traction representation / moment error", errors.tolist())
    assert np.all(np.diff(errors[:, 0]) < 0)
    assert errors[-1, 0] < .06
    assert errors[-1, 1] < min(.001, errors[0, 1]*.1)
