"""Compatibility facade for the former geometry service location."""

from app.methods.geometry import service as _service
from app.methods.geometry.service import GeometryService

__all__ = ["GeometryService"]


def __getattr__(name: str):
    return getattr(_service, name)
