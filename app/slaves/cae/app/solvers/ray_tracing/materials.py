"""Compatibility facade for the legacy ray solver locator."""

from .v0_2_0 import materials_impl as _implementation
from .v0_2_0.materials_impl import *


def __getattr__(name: str):
    return getattr(_implementation, name)
