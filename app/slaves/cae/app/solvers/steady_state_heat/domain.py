"""Compatibility facade for the legacy heat solver locator."""

from .v0_2_0.domain_impl import HeatDomain, build_heat_domain

__all__ = ["HeatDomain", "build_heat_domain"]
