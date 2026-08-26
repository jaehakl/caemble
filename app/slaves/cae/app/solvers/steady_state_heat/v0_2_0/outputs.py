"""Version-local output surface backed by the current heat implementation."""

from .outputs_impl import build_heat_outputs

__all__ = ["build_heat_outputs"]
