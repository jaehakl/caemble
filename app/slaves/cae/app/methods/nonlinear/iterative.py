from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass(frozen=True, slots=True)
class NonlinearResult:
    solution: np.ndarray[Any, Any]
    iterations: int
    residual_norm: float
    converged: bool


NonlinearCallback = Callable[[int, np.ndarray[Any, Any], float], None]


def newton(
    residual: Callable[[np.ndarray[Any, Any]], np.ndarray[Any, Any]],
    solve_linearized: Callable[[np.ndarray[Any, Any], np.ndarray[Any, Any]], np.ndarray[Any, Any]],
    initial: np.ndarray[Any, Any],
    *,
    tolerance: float = 1e-8,
    max_iterations: int = 25,
    callback: NonlinearCallback | None = None,
) -> NonlinearResult:
    solution = np.asarray(initial, dtype=np.result_type(initial, np.float64)).copy()
    value = np.asarray(residual(solution))
    residual_norm = float(np.linalg.norm(value))
    if residual_norm <= tolerance:
        return NonlinearResult(solution, 0, residual_norm, True)
    for iteration in range(1, max_iterations + 1):
        solution = solution + np.asarray(solve_linearized(solution, value))
        value = np.asarray(residual(solution))
        residual_norm = float(np.linalg.norm(value))
        if callback is not None:
            callback(iteration, solution, residual_norm)
        if residual_norm <= tolerance:
            return NonlinearResult(solution, iteration, residual_norm, True)
    return NonlinearResult(solution, max_iterations, residual_norm, False)


def picard(
    update: Callable[[np.ndarray[Any, Any]], np.ndarray[Any, Any]],
    initial: np.ndarray[Any, Any],
    *,
    relaxation: float = 1.0,
    tolerance: float = 1e-8,
    max_iterations: int = 100,
    callback: NonlinearCallback | None = None,
) -> NonlinearResult:
    solution = np.asarray(initial, dtype=np.result_type(initial, np.float64)).copy()
    residual_norm = float("inf")
    for iteration in range(1, max_iterations + 1):
        candidate = np.asarray(update(solution))
        next_solution = solution + relaxation * (candidate - solution)
        residual_norm = float(np.linalg.norm(next_solution - solution))
        solution = next_solution
        if callback is not None:
            callback(iteration, solution, residual_norm)
        if residual_norm <= tolerance:
            return NonlinearResult(solution, iteration, residual_norm, True)
    return NonlinearResult(solution, max_iterations, residual_norm, False)
