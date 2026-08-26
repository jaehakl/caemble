"""Compatibility facade for optical methods moved to :mod:`app.methods.optics`."""

from app.methods.optics import *  # noqa: F403
from app.methods.optics import physics as _physics


def __getattr__(name: str):
    return getattr(_physics, name)
