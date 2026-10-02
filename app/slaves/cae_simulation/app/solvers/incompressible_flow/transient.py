"""Single implicit Euler Navier--Stokes steps and constraint-consistent initialization."""

import asyncio
from dataclasses import dataclass

import numpy as np
from scipy import sparse
from scipy.sparse.linalg import splu

from app.kernel.api.errors import CaeError
from app.methods.finite_volume.tetrahedral import cell_operators, upwind_convection
from .linear import LinearFlowSolution, LinearFlowSystem, TransientPressureInverse, flow_mass_residual
from .periodic import split_gravity
from .pressure_recycling import PressureSubspace


@dataclass(frozen=True)
class TransientSolution(LinearFlowSolution):
    nonlinear_iterations: int = 0


class TransientStepFailure(CaeError):
    def __init__(self, message, *, time, dt, residuals, position, iterations=0):
        details = ", ".join(f"{name}={value:.6g}" for name, value in residuals.items())
        super().__init__("solver_convergence", f"Navier--Stokes candidate at time {time:g} s, dt {dt:g} s: {message}; "
                         f"residuals [{details}]; position {position}")
        self.time, self.dt, self.residuals, self.position = time, dt, residuals, position
        self.iterations = iterations


class PreparedTransientFlow:
    """Reuse geometry and boundary operators; only changed trial matrices are factored."""

    def __init__(self, mesh, density, viscosity, gravity, boundary_velocity, boundary_pressure):
        self.mesh, self.density, self.viscosity = mesh, float(density), float(viscosity)
        self.boundary_velocity = np.asarray(boundary_velocity, dtype=float).copy()
        self.boundary_pressure = np.asarray(boundary_pressure, dtype=float).copy()
        self.velocity_fixed = np.all(np.isfinite(self.boundary_velocity), axis=1) & (mesh.neighbour < 0)
        self.pressure_fixed = np.isfinite(self.boundary_pressure) & (mesh.neighbour < 0)
        self.velocity_operators = cell_operators(mesh, self.velocity_fixed)
        self.pressure_operators = cell_operators(mesh, self.pressure_fixed)
        self.free_interpolation = cell_operators(mesh, np.zeros(mesh.face_count, dtype=bool)).face_value
        self.diffusion = (-self.viscosity * mesh.divergence @ self.velocity_operators.normal_gradient).tocsr()
        self.diffusion_boundary = self.viscosity * mesh.divergence @ self.velocity_operators.normal_gradient_boundary
        self.length = float(np.cbrt(mesh.cell_volumes.sum()))
        self.areas = np.linalg.norm(mesh.area_vectors, axis=1)
        self.normals = mesh.area_vectors / self.areas[:, None]
        center = np.average(mesh.cell_centers, axis=0, weights=mesh.cell_volumes)
        hydrostatic_gravity, self.driving_acceleration = split_gravity(mesh, gravity)
        self.hydrostatic = self.density * ((mesh.cell_centers - center) @ hydrostatic_gravity)
        self.face_hydrostatic = self.density * ((mesh.face_centers - center) @ hydrostatic_gravity)
        self.body_force = self.density * mesh.cell_volumes[:, None] * self.driving_acceleration
        self.projection_matrix = (-mesh.divergence @ self.pressure_operators.normal_gradient).tocsr()
        self.preconditioner_dt, self.pressure_factor = None, None
        self.free = np.arange(len(mesh.cells)) if np.any(self.pressure_fixed) else np.arange(1, len(mesh.cells))
        try:
            self.projection_factor = splu(self.projection_matrix[self.free][:, self.free].tocsc()) if len(self.free) else None
        except RuntimeError as error:
            raise ValueError("initial flow pressure projection is singular") from error

    def _boundary_values(self, velocity=None, pressure=None):
        velocity = self.boundary_velocity if velocity is None else np.asarray(velocity, dtype=float)
        pressure = self.boundary_pressure if pressure is None else np.asarray(pressure, dtype=float)
        if (velocity.shape != self.boundary_velocity.shape or pressure.shape != self.boundary_pressure.shape
                or not np.array_equal(np.all(np.isfinite(velocity), axis=1) & (self.mesh.neighbour < 0), self.velocity_fixed)
                or not np.array_equal(np.isfinite(pressure) & (self.mesh.neighbour < 0), self.pressure_fixed)):
            raise ValueError("transient boundary overrides must preserve the prepared boundary types")
        values = np.where(self.velocity_fixed[:, None], velocity, 0)
        reduced = np.where(self.pressure_fixed, pressure - self.face_hydrostatic, 0)
        offset = float(np.mean(reduced[self.pressure_fixed])) if np.any(self.pressure_fixed) else 0.
        return values, np.where(self.pressure_fixed, reduced - offset, 0), offset

    def _project(self, base_flux, boundary_values, scale, tolerance):
        boundary_flux = self.pressure_operators.normal_gradient_boundary @ boundary_values
        rhs = self.mesh.divergence @ (boundary_flux - scale * base_flux)
        potential = np.zeros(len(self.mesh.cells))
        if self.projection_factor is not None:
            potential[self.free] = self.projection_factor.solve(rhs[self.free])
        if not np.any(self.pressure_fixed):
            potential -= np.average(potential, weights=self.mesh.cell_volumes)
        gradient = (self.pressure_operators.gauss_gradient @ potential
                    + self.pressure_operators.gauss_gradient_boundary @ boundary_values).reshape(-1, 3)
        flux = base_flux - (self.pressure_operators.normal_gradient @ potential + boundary_flux) / scale
        residual = self.projection_matrix @ potential - rhs
        # A divergence-free acceleration can leave only cancellation roundoff
        # in rhs. Its actual transported flux supplies the physical scale.
        denominator = max(float(np.linalg.norm(rhs)), float(np.linalg.norm(boundary_flux)),
                          float(np.linalg.norm(scale * base_flux)))
        relative = float(np.linalg.norm(residual) / denominator) if denominator else (0. if not np.any(residual) else float("inf"))
        if (not np.all(np.isfinite(potential)) or not np.all(np.isfinite(flux))
                or not np.isfinite(relative) or relative > tolerance):
            cell = int(np.argmax(np.abs(residual)))
            raise CaeError("solver_convergence", f"initial pressure projection residual {relative:g} exceeds {tolerance:g}; "
                           f"cell {cell}, position {self.mesh.cell_centers[cell].tolist()}")
        return potential, gradient, flux, relative

    async def initialize(self, *, max_iterations=1000, tolerance=1e-8, cancellation=None, progress=None):
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        if progress is not None:
            await progress({"stage": "flow-initialization", "completed": 0, "total": 2, "time": 0.})
        await asyncio.sleep(0)
        velocity_values, pressure_values, offset = self._boundary_values()
        potential_boundary = np.zeros(self.mesh.face_count)
        potential_boundary[self.velocity_fixed] = -np.einsum("ij,ij->i", velocity_values[self.velocity_fixed], self.normals[self.velocity_fixed])
        _, gradient, flux, velocity_projection_residual = self._project(np.zeros(self.mesh.face_count), potential_boundary, 1., tolerance)
        velocity = -gradient
        prescribed = np.einsum("ij,ij->i", velocity_values, self.mesh.area_vectors)
        flux[self.velocity_fixed] = prescribed[self.velocity_fixed]
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        if progress is not None:
            await progress({"stage": "flow-initialization", "completed": 1, "total": 2, "time": 0.})
        await asyncio.sleep(0)
        convection, convection_boundary = upwind_convection(self.mesh, flux, self.velocity_operators)
        force = (self.diffusion_boundary @ velocity_values - self.diffusion @ velocity
                 - self.density * (convection @ velocity + convection_boundary @ velocity_values) + self.body_force)
        acceleration = force / (self.density * self.mesh.cell_volumes[:, None])
        acceleration_face = self.free_interpolation @ acceleration
        acceleration_flux = np.einsum("ij,ij->i", acceleration_face, self.mesh.area_vectors)
        pressure_values[self.velocity_fixed] = self.density * np.einsum("ij,ij->i", acceleration_face[self.velocity_fixed], self.normals[self.velocity_fixed])
        pressure, _, corrected_acceleration_flux, pressure_residual = self._project(acceleration_flux, pressure_values, self.density, tolerance)
        mass = flow_mass_residual(self.mesh, flux)
        acceleration_mass = flow_mass_residual(self.mesh, corrected_acceleration_flux)
        if max(mass, acceleration_mass) > tolerance:
            failing_flux = flux if mass >= acceleration_mass else corrected_acceleration_flux
            cell = int(np.argmax(np.abs(self.mesh.divergence @ failing_flux)))
            raise CaeError("solver_convergence", f"initial continuity residuals velocity={mass:g}, acceleration={acceleration_mass:g}; "
                           f"cell {cell}, position {self.mesh.cell_centers[cell].tolist()}")
        if progress is not None:
            await progress({"stage": "flow-initialization", "completed": 2, "total": 2, "time": 0.})
        return TransientSolution(pressure + offset + self.hydrostatic, velocity, flux, 0, mass, 0.,
                                 max(velocity_projection_residual, pressure_residual), 0)

    async def step(self, *, pressure, velocity, face_volume_flux, dt, time=0., max_iterations=1000,
                   max_nonlinear_iterations=30, tolerance=1e-8, cancellation=None, progress=None,
                   boundary_velocity=None, boundary_pressure=None, previous_boundary_velocity=None):
        if not np.isfinite(dt) or dt <= 0 or not np.isfinite(time) or time + dt <= time:
            raise ValueError("transient step requires a positive representable time advance")
        old_velocity, old_flux = np.asarray(velocity, dtype=float), np.asarray(face_volume_flux, dtype=float)
        old_pressure = np.asarray(pressure, dtype=float)
        if (old_velocity.shape != (len(self.mesh.cells), 3) or old_pressure.shape != (len(self.mesh.cells),)
                or old_flux.shape != (self.mesh.face_count,) or not np.all(np.isfinite(old_velocity))
                or not np.all(np.isfinite(old_pressure)) or not np.all(np.isfinite(old_flux))):
            raise ValueError("transient initial fields must have finite mesh-aligned cell and face values")
        values, pressure_values, offset = self._boundary_values(boundary_velocity, boundary_pressure)
        old_values, _, _ = self._boundary_values(previous_boundary_velocity)
        old_face = self.velocity_operators.face_value @ old_velocity + self.velocity_operators.face_value_boundary @ old_values
        old_difference = old_flux - np.einsum("ij,ij->i", old_face, self.mesh.area_vectors)
        old_difference[self.velocity_fixed] = 0
        mass_diagonal = self.density * self.mesh.cell_volumes / dt
        if dt != self.preconditioner_dt:
            self.preconditioner_dt = dt
            self.pressure_factor = TransientPressureInverse(self.projection_factor,
                self.mesh.cell_volumes[self.free], self.density / dt, self.viscosity)
        diffusion_rhs = self.diffusion_boundary @ values
        pressure_span = float(np.ptp(pressure_values[self.pressure_fixed])) if np.any(self.pressure_fixed) else 0.
        speed = max(float(np.max(np.linalg.norm(old_velocity, axis=1))),
                    float(np.max(np.linalg.norm(values, axis=1))), dt * pressure_span / (self.density * self.length),
                    dt * float(np.linalg.norm(self.driving_acceleration)))
        reference_force = (self.viscosity * speed / self.length**2 + self.density * speed**2 / self.length
                           + pressure_span / self.length + self.density * float(np.linalg.norm(self.driving_acceleration)))
        linear_force_scale = reference_force + self.density * speed / dt
        lag_flux, iterate_pressure = old_flux.copy(), old_pressure - self.hydrostatic - offset
        # Restart/Picard reuse belongs to this candidate only. Rebuilding it at
        # every physical step preserves identical whole-window/checkpoint paths.
        pressure_subspace = PressureSubspace()
        iterations = 0
        residuals = {"mass": float("inf"), "momentum": float("inf"), "pressure": float("inf"), "flux": float("inf")}
        position = self.mesh.face_centers[int(np.argmax(self.mesh.nonorthogonality))].tolist()
        for nonlinear in range(1, max_nonlinear_iterations + 1):
            if cancellation is not None:
                cancellation.raise_if_cancelled()
            if progress is not None:
                await progress({"stage": "flow-nonlinear-iteration", "completed": nonlinear - 1,
                                "total": max_nonlinear_iterations, "time": time + dt})
            await asyncio.sleep(0)
            convection, convection_boundary = upwind_convection(self.mesh, lag_flux, self.velocity_operators)
            matrix = self.diffusion + sparse.diags(mass_diagonal) + self.density * convection
            rhs = (diffusion_rhs + mass_diagonal[:, None] * old_velocity
                   - self.density * (convection_boundary @ values) + self.body_force)
            try:
                system = LinearFlowSystem(self.mesh, self.velocity_operators, self.pressure_operators, matrix, rhs,
                    self.velocity_fixed, self.pressure_fixed, values, pressure_values, reference_speed=speed,
                    force_density_scale=linear_force_scale, old_flux_difference=old_difference,
                    temporal_coefficient=self.density / dt, pressure_factor=self.pressure_factor)
                self.pressure_factor = system.pressure_factor
                result = await system.solve(iterate_pressure, max_iterations=max_iterations, tolerance=min(tolerance * .1, 1e-10),
                                            cancellation=cancellation, progress=progress, stage="flow-pressure-iteration",
                                            recycle=pressure_subspace)
            except CaeError as error:
                if error.code != "solver_convergence":
                    raise
                raise TransientStepFailure(str(error), time=time + dt, dt=dt,
                    residuals=getattr(error, "residuals", residuals), position=position,
                    iterations=iterations + getattr(error, "iterations", 0)) from error
            iterations += result.iterations
            current_convection, current_boundary = upwind_convection(self.mesh, result.face_volume_flux, self.velocity_operators)
            inertia = mass_diagonal[:, None] * (result.velocity - old_velocity)
            diffusion = self.diffusion @ result.velocity - diffusion_rhs
            advection = self.density * (current_convection @ result.velocity + current_boundary @ values)
            gradient = (self.pressure_operators.gauss_gradient @ result.pressure
                        + self.pressure_operators.gauss_gradient_boundary @ pressure_values).reshape(-1, 3)
            pressure_force = self.mesh.cell_volumes[:, None] * gradient
            actual_residual = inertia + diffusion + advection + pressure_force - self.body_force
            scale = max(reference_force, *(float(np.max(np.linalg.norm(term, axis=1) / self.mesh.cell_volumes))
                                           for term in (inertia, diffusion, advection, pressure_force, self.body_force)))
            absolute = float(np.max(np.linalg.norm(actual_residual, axis=1) / self.mesh.cell_volumes))
            worst_cell = int(np.argmax(np.linalg.norm(actual_residual, axis=1) / self.mesh.cell_volumes))
            position = self.mesh.cell_centers[worst_cell].tolist()
            nonlinear_residual = absolute / scale if scale else (0. if absolute == 0 else float("inf"))
            transported_speed = float(np.max(np.abs(result.face_volume_flux) / self.areas))
            flux_scale = np.maximum(abs(self.mesh.divergence) @ np.abs(result.face_volume_flux),
                                    transported_speed * self.mesh.cell_volumes**(2 / 3))
            flux_change = abs(self.mesh.divergence) @ np.abs(result.face_volume_flux - lag_flux)
            flux_residual = float(np.max(np.divide(flux_change, flux_scale, out=np.zeros_like(flux_change), where=flux_scale > 0)))
            if np.any((flux_scale == 0) & (flux_change != 0)):
                flux_residual = float("inf")
            residuals = {"mass": result.mass_residual, "momentum": nonlinear_residual,
                         "pressure": result.pressure_residual, "flux": flux_residual}
            if not np.all(np.isfinite(list(residuals.values()))):
                raise TransientStepFailure("non-finite nonlinear residual", time=time + dt, dt=dt,
                                           residuals=residuals, position=position, iterations=iterations)
            if max(residuals.values()) <= tolerance:
                return TransientSolution(result.pressure + offset + self.hydrostatic, result.velocity, result.face_volume_flux,
                                         iterations, result.mass_residual, nonlinear_residual, result.pressure_residual, nonlinear)
            lag_flux, iterate_pressure = result.face_volume_flux, result.pressure
        raise TransientStepFailure(f"did not converge in {max_nonlinear_iterations} nonlinear iterations", time=time + dt,
                                   dt=dt, residuals=residuals, position=position, iterations=iterations)
