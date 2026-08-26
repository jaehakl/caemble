from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass(frozen=True, slots=True)
class SparseTriplets:
    rows: np.ndarray[Any, Any]
    columns: np.ndarray[Any, Any]
    values: np.ndarray[Any, Any]
    shape: tuple[int, int]

    def __post_init__(self) -> None:
        rows = np.asarray(self.rows, dtype=np.int64).reshape(-1)
        columns = np.asarray(self.columns, dtype=np.int64).reshape(-1)
        values = np.asarray(self.values).reshape(-1)
        if rows.size != columns.size or rows.size != values.size:
            raise ValueError("sparse triplet rows, columns, and values must have equal lengths")
        object.__setattr__(self, "rows", rows)
        object.__setattr__(self, "columns", columns)
        object.__setattr__(self, "values", values)

    def matvec(self, vector: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
        vector = np.asarray(vector)
        result = np.zeros(self.shape[0], dtype=np.result_type(self.values.dtype, vector.dtype))
        np.add.at(result, self.rows, self.values * vector[self.columns])
        return result

    def diagonal(self) -> np.ndarray[Any, Any]:
        result = np.zeros(min(self.shape), dtype=self.values.dtype)
        mask = self.rows == self.columns
        np.add.at(result, self.rows[mask], self.values[mask])
        return result

    def to_dense(self) -> np.ndarray[Any, Any]:
        result = np.zeros(self.shape, dtype=self.values.dtype)
        np.add.at(result, (self.rows, self.columns), self.values)
        return result

    def transpose(self) -> SparseTriplets:
        return SparseTriplets(self.columns, self.rows, self.values, (self.shape[1], self.shape[0]))


@dataclass(slots=True)
class TripletBuilder:
    shape: tuple[int, int]
    _rows: list[int] = field(default_factory=list, init=False)
    _columns: list[int] = field(default_factory=list, init=False)
    _values: list[complex | float] = field(default_factory=list, init=False)

    def add(self, row: int, column: int, value: complex | float) -> None:
        self._rows.append(row)
        self._columns.append(column)
        self._values.append(value)

    def add_block(
        self,
        row_dofs: np.ndarray[Any, Any],
        column_dofs: np.ndarray[Any, Any],
        values: np.ndarray[Any, Any],
    ) -> None:
        rows = np.asarray(row_dofs, dtype=np.int64).reshape(-1)
        columns = np.asarray(column_dofs, dtype=np.int64).reshape(-1)
        block = np.asarray(values)
        if block.shape != (rows.size, columns.size):
            raise ValueError("sparse block shape must match its row and column DOFs")
        for local_row, row in enumerate(rows):
            for local_column, column in enumerate(columns):
                self.add(int(row), int(column), block[local_row, local_column])

    def add_element(self, dofs: np.ndarray[Any, Any], matrix: np.ndarray[Any, Any]) -> None:
        self.add_block(dofs, dofs, matrix)

    def build(self) -> SparseTriplets:
        return SparseTriplets(
            np.asarray(self._rows, dtype=np.int64),
            np.asarray(self._columns, dtype=np.int64),
            np.asarray(self._values),
            self.shape,
        )


def assemble_element_matrices(
    dof_count: int,
    element_dofs: Iterable[np.ndarray[Any, Any]],
    element_matrices: Iterable[np.ndarray[Any, Any]],
) -> SparseTriplets:
    builder = TripletBuilder((dof_count, dof_count))
    for dofs, matrix in zip(element_dofs, element_matrices, strict=True):
        builder.add_element(dofs, matrix)
    return builder.build()
