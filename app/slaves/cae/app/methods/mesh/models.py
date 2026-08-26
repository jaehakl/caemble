from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

import numpy as np


class EntityKind(StrEnum):
    NODE = "node"
    EDGE = "edge"
    FACE = "face"
    CELL = "cell"


@dataclass(frozen=True, slots=True)
class EntitySet:
    name: str
    kind: EntityKind
    indices: np.ndarray[Any, Any]

    def __post_init__(self) -> None:
        object.__setattr__(self, "indices", np.asarray(self.indices, dtype=np.int64).reshape(-1))


@dataclass(frozen=True, slots=True)
class UnstructuredMesh:
    points: np.ndarray[Any, Any]
    cells: np.ndarray[Any, Any]
    cell_type: str = "generic"
    sets: Mapping[str, EntitySet] = field(default_factory=dict)

    def __post_init__(self) -> None:
        points = np.asarray(self.points, dtype=np.float64)
        cells = np.asarray(self.cells, dtype=np.int64)
        if points.ndim != 2 or cells.ndim != 2:
            raise ValueError("mesh points and cells must both be rank-2 arrays")
        if cells.size and (int(cells.min()) < 0 or int(cells.max()) >= points.shape[0]):
            raise ValueError("cell connectivity references a node outside the mesh")
        object.__setattr__(self, "points", points)
        object.__setattr__(self, "cells", cells)

    @property
    def spatial_dimension(self) -> int:
        return int(self.points.shape[1])

    @property
    def node_count(self) -> int:
        return int(self.points.shape[0])

    @property
    def cell_count(self) -> int:
        return int(self.cells.shape[0])

    def cell_coordinates(self) -> np.ndarray[Any, Any]:
        return self.points[self.cells]
