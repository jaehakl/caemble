"""Compatibility exports for :mod:`app.methods.finite_volume`."""

from app.methods.finite_volume import (
    FiniteVolumeSystem,
    create_scalar_finite_volume_system,
    solve_pcg,
)
from app.methods.finite_volume.scalar import _apply_matrix

__all__ = ["FiniteVolumeSystem", "create_scalar_finite_volume_system", "solve_pcg"]
