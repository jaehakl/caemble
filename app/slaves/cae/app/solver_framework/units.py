from __future__ import annotations

import math
import re
from typing import Any

from ucumvert import PintUcumRegistry

from app.errors import CaeError

_registry = PintUcumRegistry()
_annotation = re.compile(r"^\{[^{}]+\}$")


def convert_ucum_value(
    value: int | float,
    source_unit: str,
    target_unit: str,
    path: str,
) -> float:
    if not isinstance(source_unit, str) or not source_unit:
        raise CaeError("invalid_unit", f"{path}.unit must be a non-empty UCUM unit")
    if not isinstance(target_unit, str) or not target_unit:
        raise CaeError("descriptor_mismatch", f"{path} manifest unit is invalid")
    try:
        source = _parsed_unit(source_unit)
        target = _parsed_unit(target_unit)
        quantity = _registry.Quantity(
            value * source[0],
            source[1],
        )
        converted = quantity.to(target[1]).magnitude / target[0]
    except Exception as exc:
        raise CaeError(
            "invalid_unit",
            f"{path}.unit {source_unit!r} is not convertible to manifest unit {target_unit!r}",
        ) from exc
    if not math.isfinite(converted):
        raise CaeError(
            "invalid_unit",
            f"{path} conversion from {source_unit!r} to {target_unit!r} is not finite",
        )
    return float(converted)


def convert_ucum_tensor(
    value: Any,
    source_unit: str,
    target_unit: str,
    path: str,
) -> Any:
    if isinstance(value, list):
        return [
            convert_ucum_tensor(item, source_unit, target_unit, f"{path}[{index}]")
            for index, item in enumerate(value)
        ]
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise CaeError("invalid_task", f"{path} must contain finite numeric values")
    return convert_ucum_value(value, source_unit, target_unit, path)


def _parsed_unit(unit: str) -> tuple[float, Any]:
    if _annotation.fullmatch(unit):
        return 1.0, _registry.dimensionless
    parsed = _registry.from_ucum(unit)
    parsed_unit = getattr(parsed, "units", None)
    magnitude = getattr(parsed, "magnitude", None)
    if parsed_unit is None or not isinstance(magnitude, (int, float)):
        raise ValueError(f"unsupported UCUM unit {unit!r}")
    return float(magnitude), parsed_unit
