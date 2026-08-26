"""Compatibility facade for the legacy ray solver locator."""

from .v0_2_0 import domain_impl as _implementation
from .v0_2_0.domain_impl import *


def __getattr__(name: str):
    return getattr(_implementation, name)
