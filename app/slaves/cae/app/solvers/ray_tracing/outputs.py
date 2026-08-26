"""Compatibility facade for the legacy ray solver locator."""

from .v0_2_0 import outputs_impl as _implementation
from .v0_2_0.outputs_impl import *


def __getattr__(name: str):
    return getattr(_implementation, name)
