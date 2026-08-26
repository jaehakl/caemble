from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np


class LinearOperator(Protocol):
    shape: tuple[int, int]

    def matvec(self, vector: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]: ...


@dataclass(frozen=True, slots=True)
class CallableLinearOperator:
    shape: tuple[int, int]
    apply: Callable[[np.ndarray[Any, Any]], np.ndarray[Any, Any]]

    def matvec(self, vector: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
        return np.asarray(self.apply(vector))


@dataclass(frozen=True, slots=True)
class DenseLinearOperator:
    matrix: np.ndarray[Any, Any]

    def __post_init__(self) -> None:
        matrix = np.asarray(self.matrix)
        if matrix.ndim != 2:
            raise ValueError("a dense linear operator must be a rank-2 matrix")
        object.__setattr__(self, "matrix", matrix)

    @property
    def shape(self) -> tuple[int, int]:
        return self.matrix.shape

    def matvec(self, vector: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
        return self.matrix @ vector


@dataclass(frozen=True, slots=True)
class IterativeResult:
    solution: np.ndarray[Any, Any]
    iterations: int
    relative_residual: float
    converged: bool


IterationCallback = Callable[[int, np.ndarray[Any, Any], float], None]
Preconditioner = Callable[[np.ndarray[Any, Any]], np.ndarray[Any, Any]]


def jacobi_preconditioner(diagonal: np.ndarray[Any, Any]) -> Preconditioner:
    inverse = 1.0 / np.asarray(diagonal)
    return lambda residual: inverse * residual


def conjugate_gradient(
    operator: LinearOperator,
    right_hand_side: np.ndarray[Any, Any],
    *,
    initial: np.ndarray[Any, Any] | None = None,
    preconditioner: Preconditioner | None = None,
    tolerance: float = 1e-8,
    max_iterations: int | None = None,
    callback: IterationCallback | None = None,
) -> IterativeResult:
    rhs = np.asarray(right_hand_side).reshape(-1)
    solution = np.zeros_like(rhs, dtype=np.result_type(rhs.dtype, np.float64))
    if initial is not None:
        solution = np.asarray(initial, dtype=np.result_type(initial, np.float64)).reshape(-1).copy()
    residual = rhs - operator.matvec(solution)
    dtype = np.result_type(solution.dtype, residual.dtype)
    solution = solution.astype(dtype, copy=False)
    residual = residual.astype(dtype, copy=False)
    rhs_norm = float(np.linalg.norm(rhs)) or 1.0
    relative_residual = float(np.linalg.norm(residual) / rhs_norm)
    if relative_residual <= tolerance:
        return IterativeResult(solution, 0, relative_residual, True)
    preconditioned = residual.copy() if preconditioner is None else np.asarray(preconditioner(residual))
    direction = preconditioned.copy()
    residual_product = np.vdot(residual, preconditioned)
    iteration_limit = max_iterations if max_iterations is not None else max(1, 10 * rhs.size)
    for iteration in range(1, iteration_limit + 1):
        product = operator.matvec(direction)
        denominator = np.vdot(direction, product)
        if abs(denominator) <= np.finfo(float).eps:
            return IterativeResult(solution, iteration - 1, relative_residual, False)
        alpha = residual_product / denominator
        solution += alpha * direction
        residual -= alpha * product
        relative_residual = float(np.linalg.norm(residual) / rhs_norm)
        if callback is not None:
            callback(iteration, solution, relative_residual)
        if relative_residual <= tolerance:
            return IterativeResult(solution, iteration, relative_residual, True)
        preconditioned = residual.copy() if preconditioner is None else np.asarray(preconditioner(residual))
        next_residual_product = np.vdot(residual, preconditioned)
        if abs(residual_product) <= np.finfo(float).eps:
            return IterativeResult(solution, iteration, relative_residual, False)
        direction = preconditioned + (next_residual_product / residual_product) * direction
        residual_product = next_residual_product
    return IterativeResult(solution, iteration_limit, relative_residual, False)


def gmres(
    operator: LinearOperator,
    right_hand_side: np.ndarray[Any, Any],
    *,
    initial: np.ndarray[Any, Any] | None = None,
    preconditioner: Preconditioner | None = None,
    tolerance: float = 1e-8,
    max_iterations: int | None = None,
    restart: int = 30,
    callback: IterationCallback | None = None,
) -> IterativeResult:
    if restart < 1:
        raise ValueError("GMRES restart must be at least one")
    rhs = np.asarray(right_hand_side).reshape(-1)
    solution = np.zeros_like(rhs, dtype=np.result_type(rhs.dtype, np.float64))
    if initial is not None:
        solution = np.asarray(initial, dtype=np.result_type(initial, np.float64)).reshape(-1).copy()
    initial_residual = rhs - operator.matvec(solution)
    dtype = np.result_type(solution.dtype, initial_residual.dtype)
    solution = solution.astype(dtype, copy=False)
    rhs_norm = float(np.linalg.norm(rhs)) or 1.0
    iteration_limit = max_iterations if max_iterations is not None else max(1, 10 * rhs.size)
    iterations = 0
    relative_residual = float(np.linalg.norm(rhs - operator.matvec(solution)) / rhs_norm)
    if relative_residual <= tolerance:
        return IterativeResult(solution, 0, relative_residual, True)
    while iterations < iteration_limit:
        base_solution = solution.copy()
        residual = rhs - operator.matvec(base_solution)
        krylov_residual = residual if preconditioner is None else np.asarray(preconditioner(residual))
        beta = float(np.linalg.norm(krylov_residual))
        if beta <= np.finfo(float).eps:
            return IterativeResult(solution, iterations, relative_residual, False)
        cycle = min(restart, iteration_limit - iterations, rhs.size)
        basis = np.zeros((rhs.size, cycle + 1), dtype=dtype)
        hessenberg = np.zeros((cycle + 1, cycle), dtype=dtype)
        basis[:, 0] = krylov_residual / beta
        for local_iteration in range(cycle):
            product = operator.matvec(basis[:, local_iteration])
            if preconditioner is not None:
                product = np.asarray(preconditioner(product))
            for basis_index in range(local_iteration + 1):
                hessenberg[basis_index, local_iteration] = np.vdot(
                    basis[:, basis_index],
                    product,
                )
                product -= hessenberg[basis_index, local_iteration] * basis[:, basis_index]
            next_norm = float(np.linalg.norm(product))
            hessenberg[local_iteration + 1, local_iteration] = next_norm
            if next_norm > np.finfo(float).eps:
                basis[:, local_iteration + 1] = product / next_norm
            target = np.zeros(local_iteration + 2, dtype=dtype)
            target[0] = beta
            coefficients = np.linalg.lstsq(
                hessenberg[: local_iteration + 2, : local_iteration + 1],
                target,
                rcond=None,
            )[0]
            solution = base_solution + basis[:, : local_iteration + 1] @ coefficients
            iterations += 1
            relative_residual = float(np.linalg.norm(rhs - operator.matvec(solution)) / rhs_norm)
            if callback is not None:
                callback(iterations, solution, relative_residual)
            if relative_residual <= tolerance:
                return IterativeResult(solution, iterations, relative_residual, True)
            if next_norm <= np.finfo(float).eps:
                break
    return IterativeResult(solution, iterations, relative_residual, False)
