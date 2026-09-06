"""Solver contracts and detached values, independent of resident resource stores."""

from importlib import import_module
from typing import Any

from app.runtime_kernel.api.cache import ContentKey, ValueCache
from app.runtime_kernel.api.models import (
    CancellationToken,
    InputArtifact,
    MaterialView,
    ProgressReporter,
    SolverImplementation,
    SolverInvocation,
    SolverResourceServices,
    SolverResult,
    SolverRunner,
    WorldView,
)
from app.runtime_kernel.api.services import GeometryService
from app.runtime_kernel.api.state import StateDelete, StatePatch, StatePut
from app.runtime_kernel.api.units import convert_ucum_tensor, convert_ucum_value
from app.runtime_kernel.api.values import (
    BundleValue,
    DomainValue,
    FieldLocation,
    FieldValue,
    ParticleSetValue,
    RaySetValue,
    StructuredGridValue,
    UnstructuredMeshValue,
)

__all__ = [
    "BundleValue",
    "CancellationToken",
    "ContentKey",
    "DomainValue",
    "FieldLocation",
    "FieldValue",
    "GeometryService",
    "InputArtifact",
    "MaterialView",
    "ParticleSetValue",
    "ProgressReporter",
    "RaySetValue",
    "SolverImplementation",
    "SolverInvocation",
    "SolverResourceServices",
    "SolverResult",
    "SolverRunner",
    "StateDelete",
    "StatePatch",
    "StatePut",
    "StructuredGridValue",
    "UnstructuredMeshValue",
    "ValueCache",
    "WorldView",
    "convert_ucum_tensor",
    "convert_ucum_value",
]

_VALUE_ALIASES = {
    "StructuredGrid": StructuredGridValue,
    "UnstructuredMesh": UnstructuredMeshValue,
    "ParticleSet": ParticleSetValue,
    "RaySet": RaySetValue,
    "StructuredBundle": BundleValue,
}
_RESOURCE_COMPATIBILITY = {
    "ArtifactHandle",
    "ArtifactProvenance",
    "ArtifactStore",
    "Field",
    "FileResourceCache",
    "ImmutableResourceCache",
    "ResourceRef",
    "ResourceStore",
    "ResourceTreeRef",
    "StateHandle",
    "StateRevision",
    "StateStore",
    "StateView",
}


def __getattr__(name: str) -> Any:
    """Keep old explicit imports available without loading runtime implementations."""
    if name in _VALUE_ALIASES:
        value = _VALUE_ALIASES[name]
    elif name in _RESOURCE_COMPATIBILITY:
        value = getattr(import_module("app.runtime_kernel.resources"), name)
    elif name in {"LegacySolverAdapter", "adapt_legacy_result"}:
        value = getattr(import_module("app.runtime_kernel.compat.legacy"), name)
    else:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    globals()[name] = value
    return value
