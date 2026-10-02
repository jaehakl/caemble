from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from itertools import product
from typing import Any, Protocol

import numpy as np


@dataclass(frozen=True, slots=True)
class DOFMap:
    entity_dofs: np.ndarray[Any, Any]

    def __post_init__(self) -> None:
        dofs = np.asarray(self.entity_dofs, dtype=np.int64)
        if dofs.ndim != 2:
            raise ValueError("entity DOFs must be a rank-2 array")
        object.__setattr__(self, "entity_dofs", dofs)

    @classmethod
    def nodal(cls, node_count: int, components: int = 1) -> DOFMap:
        return cls(np.arange(node_count * components, dtype=np.int64).reshape(node_count, components))

    @property
    def size(self) -> int:
        return int(self.entity_dofs.max()) + 1 if self.entity_dofs.size else 0

    def element_dofs(self, connectivity: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
        cells = np.asarray(connectivity, dtype=np.int64)
        return self.entity_dofs[cells].reshape(cells.shape[0], -1)


@dataclass(frozen=True, slots=True)
class QuadratureRule:
    points: np.ndarray[Any, Any]
    weights: np.ndarray[Any, Any]

    def __post_init__(self) -> None:
        points = np.asarray(self.points, dtype=np.float64)
        weights = np.asarray(self.weights, dtype=np.float64).reshape(-1)
        if points.ndim != 2 or points.shape[0] != weights.size:
            raise ValueError("quadrature points and weights must have the same leading dimension")
        object.__setattr__(self, "points", points)
        object.__setattr__(self, "weights", weights)


def gauss_legendre(order: int, dimensions: int = 1) -> QuadratureRule:
    coordinates, weights = np.polynomial.legendre.leggauss(order)
    point_indices = tuple(product(range(order), repeat=dimensions))
    points = np.asarray([[coordinates[index] for index in indices] for indices in point_indices])
    tensor_weights = np.asarray([np.prod([weights[index] for index in indices]) for indices in point_indices])
    return QuadratureRule(points, tensor_weights)


def integrate_quadrature(
    values: np.ndarray[Any, Any],
    jacobian_determinants: np.ndarray[Any, Any],
    rule: QuadratureRule,
) -> np.ndarray[Any, Any]:
    samples = np.asarray(values)
    jacobians = np.asarray(jacobian_determinants).reshape(-1)
    if samples.shape[0] != rule.weights.size or jacobians.size != rule.weights.size:
        raise ValueError("quadrature values and Jacobians must match the rule")
    return np.tensordot(rule.weights * jacobians, samples, axes=(0, 0))


@dataclass(frozen=True, slots=True)
class DirichletConstraints:
    dofs: np.ndarray[Any, Any]
    values: np.ndarray[Any, Any]

    def __post_init__(self) -> None:
        dofs = np.asarray(self.dofs, dtype=np.int64).reshape(-1)
        values = np.asarray(self.values).reshape(-1)
        if dofs.size != values.size:
            raise ValueError("each constrained DOF must have one value")
        object.__setattr__(self, "dofs", dofs)
        object.__setattr__(self, "values", values)

    def apply_dense(
        self,
        matrix: np.ndarray[Any, Any],
        right_hand_side: np.ndarray[Any, Any],
    ) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]:
        dtype = np.result_type(matrix, right_hand_side, self.values)
        constrained_matrix = np.asarray(matrix, dtype=dtype).copy()
        constrained_rhs = np.asarray(right_hand_side, dtype=dtype).copy()
        constrained_rhs -= constrained_matrix[:, self.dofs] @ self.values
        constrained_matrix[:, self.dofs] = 0
        constrained_matrix[self.dofs, :] = 0
        constrained_matrix[self.dofs, self.dofs] = 1
        constrained_rhs[self.dofs] = self.values
        return constrained_matrix, constrained_rhs


class ElementKernel(Protocol):
    def __call__(
        self,
        coordinates: np.ndarray[Any, Any],
        fields: Mapping[str, np.ndarray[Any, Any]],
    ) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]: ...
