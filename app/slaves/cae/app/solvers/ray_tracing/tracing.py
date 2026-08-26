"""Compatibility facade for ray methods moved to :mod:`app.methods.rays`."""

from app.methods.rays import *  # noqa: F403
from app.methods.rays import tracing as _tracing


def __getattr__(name: str):
    return getattr(_tracing, name)
