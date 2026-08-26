"""Version-local domain surface backed by the current heat implementation."""

from .domain_impl import HeatDomain, build_heat_domain

__all__ = ["HeatDomain", "build_heat_domain"]
