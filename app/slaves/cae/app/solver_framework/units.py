from __future__ import annotations

import re
from typing import Any

from ucumvert import PintUcumRegistry

_registry = PintUcumRegistry()
_annotation = re.compile(r"^\{[^{}]+\}$")


def convert_ucum_value(
    value: int | float,
    source_unit: str,
    target_unit: str,
    path: str,
) -> float:
    del path
    source = _parsed_unit(source_unit)
    target = _parsed_unit(target_unit)
    quantity = _registry.Quantity(value * source[0], source[1])
    converted = quantity.to(target[1]).magnitude / target[0]
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
    return convert_ucum_value(value, source_unit, target_unit, path)


def _parsed_unit(unit: str) -> tuple[float, Any]:
    if _annotation.fullmatch(unit):
        return 1.0, _registry.dimensionless
    parsed = _registry.from_ucum(unit)
    return float(parsed.magnitude), parsed.units
