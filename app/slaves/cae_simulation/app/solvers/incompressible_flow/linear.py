"""Prepared momentum elimination and SIMPLE-preconditioned pressure corrections."""

import asyncio
from dataclasses import dataclass

import numpy as np
from scipy import sparse
from scipy.sparse.linalg import splu

from app.kernel.api.errors import CaeError


@dataclass(frozen=True)
class LinearFlowSolution:
    pressure: np.ndarray
    velocity: np.ndarray
    face_volume_flux: np.ndarray
    iterations: int
    mass_residual: float
    momentum_residual: float
    pressure_residual: float


@dataclass(frozen=True)
class TransientPressureInverse:
    """Cahouet--Chabard inverse: (rho/dt) L_p^-1 + mu M_p^-1.

    This only preconditions the exact Rhie--Chow Schur operator. The pressure
    Laplacian factor comes from initialization and survives time-step changes.
    """

    factor: object
    volumes: np.ndarray
    inertia: float
    viscosity: float

    def solve(self, rhs):
        return self.inertia * self.factor.solve(rhs) + self.viscosity * rhs / self.volumes


def flow_mass_residual(mesh, flux):
    absolute_divergence = abs(mesh.divergence)
    speed = float(np.max(np.abs(flux) / np.linalg.norm(mesh.area_vectors, axis=1)))
    scale = np.maximum(absolute_divergence @ np.abs(flux), speed * mesh.cell_volumes**(2 / 3))
    error = np.abs(mesh.divergence @ flux)
    residual = float(np.max(np.divide(error, scale, out=np.zeros_like(error), where=scale > 0)))
    if np.any((scale == 0) & (error != 0)):
        return float("inf")
    boundary = flux[mesh.neighbour < 0]
    boundary_scale = float(np.abs(boundary).sum()) or speed * mesh.cell_volumes.sum()**(2 / 3)
    return max(residual, abs(float(boundary.sum())) / boundary_scale) if boundary_scale else residual


class LinearFlowSystem:
    """One frozen momentum matrix; all Krylov actions reuse its factorization."""

    def __init__(self, mesh, velocity_operators, pressure_operators, momentum_matrix, momentum_rhs,
                 velocity_fixed, pressure_fixed, velocity_values, pressure_values,
                 *, reference_speed, force_density_scale, old_flux_difference=None, temporal_coefficient=0.,
                 pressure_factor=None, preconditioner_diagonal=None):
        self.mesh, self.velocity_operators, self.pressure_operators = mesh, velocity_operators, pressure_operators
        self.momentum_matrix, self.momentum_rhs = momentum_matrix.tocsr(), momentum_rhs
        self.velocity_fixed, self.pressure_fixed = velocity_fixed, pressure_fixed
        self.force_density_scale = force_density_scale
        volume, owner, neighbour = mesh.cell_volumes, mesh.owner, mesh.neighbour
        diagonal = self.momentum_matrix.diagonal()
        if np.any(diagonal <= 0):
            cell = int(np.flatnonzero(diagonal <= 0)[0])
            raise CaeError("solver_convergence", f"flow momentum has a nonpositive diagonal at cell {cell}, "
                           f"position {mesh.cell_centers[cell].tolist()}")
        self.mobility = volume / diagonal
        internal = neighbour >= 0
        weights = mesh.interpolation_weights
        face_mobility = self.mobility[owner].copy()
        face_mobility[internal] = (weights[internal] * self.mobility[owner[internal]]
                                   + (1 - weights[internal]) * self.mobility[neighbour[internal]])
        self.flux_pressure = sparse.diags(face_mobility) @ pressure_operators.normal_gradient
        flux_boundary = face_mobility * (pressure_operators.normal_gradient_boundary @ pressure_values)
        self.gradient_boundary = (pressure_operators.gauss_gradient_boundary @ pressure_values).reshape(-1, 3)
        self.free = np.arange(len(volume)) if np.any(pressure_fixed) else np.arange(1, len(volume))
        # Interpolate u and D*grad(p) with the identical skew reconstruction.
        # Then pure Euler inertia cancels these pressure terms exactly, leaving
        # the old corrected face flux and a conservative pressure increment.
        self.interpolator = velocity_operators.face_value
        try:
            self.momentum_factor = splu(self.momentum_matrix.tocsc(), permc_spec="MMD_AT_PLUS_A",
                                        options={"SymmetricMode": True})
            self.pressure_factor = pressure_factor
            if pressure_factor is None and len(self.free):
                approximate_mobility = volume / (diagonal if preconditioner_diagonal is None else preconditioner_diagonal)
                approximate_face = approximate_mobility[owner].copy()
                approximate_face[internal] = (weights[internal] * approximate_mobility[owner[internal]]
                                               + (1 - weights[internal]) * approximate_mobility[neighbour[internal]])
                approximation = -sparse.diags(approximate_face) @ pressure_operators.normal_gradient
                approximation = sparse.diags((~velocity_fixed).astype(float)) @ approximation
                pressure_matrix = (mesh.divergence @ approximation).tocsr()
                self.pressure_factor = splu(pressure_matrix[self.free][:, self.free].tocsc())
        except RuntimeError as error:
            face = int(np.argmax(mesh.nonorthogonality))
            raise CaeError("solver_convergence", "flow momentum or pressure system is singular; "
                           f"maximum nonorthogonality at face {face}, position {mesh.face_centers[face].tolist()}") from error
        base_rhs = momentum_rhs - volume[:, None] * self.gradient_boundary
        self.base_velocity = self.momentum_factor.solve(base_rhs)
        # Recover the LU backward error before a small time step magnifies it
        # in rho*(u_new-u_old)/dt. This leaves the assembled equation unchanged.
        self.base_velocity += self.momentum_factor.solve(base_rhs - self.momentum_matrix @ self.base_velocity)
        base_face = velocity_operators.face_value @ self.base_velocity + velocity_operators.face_value_boundary @ velocity_values
        pressure_velocity = self.interpolator @ (self.mobility[:, None] * self.gradient_boundary)
        self.base_flux = np.einsum("ij,ij->i", base_face + pressure_velocity, mesh.area_vectors) - flux_boundary
        if old_flux_difference is not None:
            self.base_flux += temporal_coefficient * face_mobility * old_flux_difference
        prescribed = np.einsum("ij,ij->i", velocity_values, mesh.area_vectors)
        self.base_flux[velocity_fixed] = prescribed[velocity_fixed]
        self.rhs = -(mesh.divergence @ self.base_flux)
        self.pressure_scale = max(float(np.linalg.norm(self.rhs)), reference_speed * volume.sum()**(2 / 3))

    def response(self, pressure):
        gradient = (self.pressure_operators.gauss_gradient @ pressure).reshape(-1, 3)
        velocity = -self.momentum_factor.solve(self.mesh.cell_volumes[:, None] * gradient)
        face = self.velocity_operators.face_value @ velocity
        pressure_velocity = self.interpolator @ (self.mobility[:, None] * gradient)
        flux = np.einsum("ij,ij->i", face + pressure_velocity, self.mesh.area_vectors) - self.flux_pressure @ pressure
        flux[self.velocity_fixed] = 0
        return velocity, flux, gradient

    async def solve(self, initial_pressure=None, *, max_iterations=1000, tolerance=1e-8,
                    cancellation=None, progress=None, stage="stokes-iteration", recycle=None):
        from scipy.linalg import solve_triangular

        mesh, volume = self.mesh, self.mesh.cell_volumes
        pressure = np.zeros(len(volume)) if initial_pressure is None else np.asarray(initial_pressure, dtype=float).copy()
        if not np.any(self.rhs):
            pressure.fill(0)
        iteration, restart = 0, min(200, max(1, len(self.free)))
        local, evaluate = 0, True
        preconditioned = raw_hessenberg = None
        mass_residual = momentum_residual = pressure_residual = float("inf")
        while iteration <= max_iterations:
            if cancellation is not None:
                cancellation.raise_if_cancelled()
            if progress is not None:
                await progress({"stage": stage, "completed": iteration, "total": max_iterations})
            await asyncio.sleep(0)
            if evaluate:
                if not np.any(self.pressure_fixed):
                    pressure -= np.average(pressure, weights=volume)
                response_velocity, response_flux, response_gradient = self.response(pressure)
                velocity, flux = self.base_velocity + response_velocity, self.base_flux + response_flux
                gradient = self.gradient_boundary + response_gradient
                momentum_error = self.momentum_matrix @ velocity + volume[:, None] * gradient - self.momentum_rhs
                absolute = float(np.max(np.linalg.norm(momentum_error, axis=1) / volume))
                momentum_residual = absolute / self.force_density_scale if self.force_density_scale else (0. if absolute == 0 else float("inf"))
                mass_residual = flow_mass_residual(mesh, flux)
                residual = self.rhs - mesh.divergence @ response_flux
                pressure_residual = float(np.linalg.norm(residual) / self.pressure_scale) if self.pressure_scale else (0. if not np.any(residual) else float("inf"))
                if (not np.all(np.isfinite(velocity)) or not np.all(np.isfinite(pressure)) or not np.all(np.isfinite(flux))
                        or not np.all(np.isfinite([momentum_residual, mass_residual, pressure_residual]))):
                    raise CaeError("solver_convergence", f"flow iteration {iteration} produced non-finite pressure, velocity, flux or residual")
                if max(momentum_residual, mass_residual, pressure_residual) <= tolerance:
                    if recycle is not None and iteration:
                        recycle.capture(preconditioned, raw_hessenberg, local)
                    return LinearFlowSolution(pressure, velocity, flux, iteration, mass_residual, momentum_residual, pressure_residual)
                if iteration == max_iterations or not len(self.free):
                    break
            if local == 0:
                coarse_q, coarse_u = ((None, None) if recycle is None else
                                      await recycle.prepare(self, cancellation=cancellation))
                base_pressure = pressure.copy()
                beta = float(np.linalg.norm(residual[self.free]))
                if beta == 0:
                    break
                # Arnoldi uses contiguous columns throughout both MGS passes.
                basis = np.zeros((len(self.free), restart + 1), order="F")
                basis[:, 0] = residual[self.free] / beta
                preconditioned = np.zeros((len(volume), restart), order="F")
                hessenberg = np.zeros((restart + 1, restart))
                raw_hessenberg = np.zeros_like(hessenberg) if recycle is not None else None
                cosines, sines = np.zeros(restart), np.zeros(restart)
                target = np.zeros(restart + 1)
                target[0] = beta
            if coarse_q is None:
                preconditioned[self.free, local] = self.pressure_factor.solve(basis[:, local])
            else:
                coordinates = coarse_q.T @ basis[:, local]
                remainder = basis[:, local] - coarse_q @ coordinates
                preconditioned[self.free, local] = coarse_u @ coordinates + self.pressure_factor.solve(remainder)
            _, correction_flux, _ = self.response(preconditioned[:, local])
            product = (mesh.divergence @ correction_flux)[self.free]
            for _ in range(2):
                for column in range(local + 1):
                    coefficient = float(np.dot(basis[:, column], product))
                    hessenberg[column, local] += coefficient
                    product -= coefficient * basis[:, column]
            next_norm = float(np.linalg.norm(product))
            if not np.isfinite(next_norm):
                raise CaeError("solver_convergence", f"flow iteration {iteration} produced a non-finite pressure correction")
            hessenberg[local + 1, local] = next_norm
            if raw_hessenberg is not None:
                raw_hessenberg[:, local] = hessenberg[:, local]
            if next_norm:
                basis[:, local + 1] = product / next_norm
            # Update the QR factorization with one Givens rotation, retaining
            # the same GMRES least-squares problem without a repeated SVD.
            for column in range(local):
                first, second = hessenberg[column:column + 2, local]
                hessenberg[column, local] = cosines[column] * first + sines[column] * second
                hessenberg[column + 1, local] = -sines[column] * first + cosines[column] * second
            first, second = hessenberg[local:local + 2, local]
            magnitude = float(np.hypot(first, second))
            cosines[local], sines[local] = (first / magnitude, second / magnitude) if magnitude else (1., 0.)
            hessenberg[local, local], hessenberg[local + 1, local] = magnitude, 0.
            target[local + 1] = -sines[local] * target[local]
            target[local] *= cosines[local]
            iteration += 1
            local += 1
            evaluate = (abs(target[local]) <= tolerance * self.pressure_scale
                        or local == restart or iteration == max_iterations or next_norm == 0.)
            if evaluate:
                triangular = hessenberg[:local, :local]
                # Exact Arnoldi breakdown can leave a rank-deficient reduced
                # problem; its least-squares candidate still needs full checks.
                coefficients = (np.linalg.lstsq(triangular, target[:local], rcond=None)[0]
                                if np.any(np.diag(triangular) == 0.) else
                                solve_triangular(triangular, target[:local]))
                pressure = base_pressure + preconditioned[:, :local] @ coefficients
            if local == restart or next_norm == 0.:
                if recycle is not None:
                    recycle.capture(preconditioned, raw_hessenberg, local)
                local = 0
        face = int(np.argmax(mesh.nonorthogonality))
        error = CaeError("solver_convergence", f"flow did not converge in {iteration} iterations "
                         f"(mass {mass_residual:.3g}, momentum {momentum_residual:.3g}, pressure {pressure_residual:.3g}); "
                         f"maximum nonorthogonality {mesh.nonorthogonality[face]:.3g} degrees at face {face}, "
                         f"position {mesh.face_centers[face].tolist()}")
        error.residuals = {"mass": mass_residual, "momentum": momentum_residual, "pressure": pressure_residual}
        error.iterations = iteration
        raise error
