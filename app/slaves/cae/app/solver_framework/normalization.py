"""Compatibility facade for runtime task normalization."""

from app.runtime_kernel.catalog.normalization import normalize_parameter_value, normalize_task_config

__all__ = ["normalize_parameter_value", "normalize_task_config"]
