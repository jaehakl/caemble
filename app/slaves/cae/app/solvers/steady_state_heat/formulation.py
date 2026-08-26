"""Compatibility facade for the legacy heat solver locator."""

from .v0_2_0.formulation_impl import HeatSolution, _volume_source, solve_heat

__all__ = ["HeatSolution", "_volume_source", "solve_heat"]
