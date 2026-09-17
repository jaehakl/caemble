"""Explicit preparation data and shared beam kinematic batches."""

from dataclasses import dataclass
from typing import Any

from scipy import sparse

from ..beam import beam_batch_kinematics


@dataclass(frozen=True)
class PreparedStructuralOperators:
    """Reference operators and reusable element data, never a checkpoint."""

    # The thermal CG path stores only its constrained stiffness in thermal_batch.
    stiffness: sparse.spmatrix | None
    mass: sparse.spmatrix
    damping: sparse.spmatrix
    element_data: list[dict[str, Any]]
    beam_batch: dict[str, Any] | None = None
    thermal_batch: dict[str, Any] | None = None


def _beam_batch(model, displacement, orientations, prepared):
    """같은 보 묶음의 변형·frame·Jacobian을 세 물리 평가에서 공유합니다."""
    data = prepared.beam_batch
    if data is None:
        return None
    nodes = data["nodes"]
    return data, beam_batch_kinematics(model.points[nodes], displacement[nodes, :3], orientations[nodes], data["frame"])
