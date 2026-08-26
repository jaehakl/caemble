"""Compatibility facade for the legacy DC solver locator."""

from .v0_3_0.formulation_impl import (
    DcSolution,
    _cross_section,
    _gradient,
    solve_dc,
)

__all__ = ["DcSolution", "_cross_section", "_gradient", "solve_dc"]
