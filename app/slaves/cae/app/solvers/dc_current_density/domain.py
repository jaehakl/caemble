"""Compatibility facade for the legacy DC solver locator."""

from .v0_3_0.domain_impl import (
    DcDomain,
    ElectrodeVoxelDomain,
    build_dc_domain,
    build_electrode_voxel_domain,
)

__all__ = [
    "DcDomain",
    "ElectrodeVoxelDomain",
    "build_dc_domain",
    "build_electrode_voxel_domain",
]
