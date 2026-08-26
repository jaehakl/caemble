"""Compatibility facade for the legacy heat solver locator."""

from .v0_2_0.outputs_impl import build_heat_outputs

__all__ = ["build_heat_outputs"]
