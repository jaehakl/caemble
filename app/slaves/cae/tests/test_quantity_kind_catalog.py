from __future__ import annotations

from functools import lru_cache
from typing import Any

import pytest
from caemble_catalog import open_catalog

from app.solver_framework.units import convert_ucum_value
from app.solver_framework.registry import registry

OPAQUE_QUANTITY_KINDS = (
    "LinearLogarithmicRatio",
    "thermodynamics.AreaTimeTemperature",
    "thermodynamics.LengthTemperatureTime",
    "thermodynamics.TemperatureVariance",
    "chemistry.Acidity",
    "chemistry.Basicity",
)


def _load_catalog() -> tuple[dict[str, Any], tuple[str, ...]]:
    with open_catalog() as catalog:
        definitions, total = catalog.list_quantity_kinds(limit=2_000)
    assert total == len(definitions)
    return (
        {definition["name"]: definition for definition in definitions},
        tuple(definition["name"] for definition in definitions if definition["opaque"]),
    )


@lru_cache(maxsize=None)
def _assert_bidirectional_conversion(source: str, target: str, path: str) -> None:
    for value in (0, 1):
        convert_ucum_value(value, source, target, path)
        convert_ucum_value(value, target, source, path)


def _quantity_descriptors(value: Any):
    if isinstance(value, dict):
        if isinstance(value.get("quantityKind"), str) and isinstance(value.get("unit"), str):
            yield value
        for child in value.values():
            yield from _quantity_descriptors(child)
    elif isinstance(value, list):
        for child in value:
            yield from _quantity_descriptors(child)


@pytest.mark.slow
def test_sqlite_catalog_units_are_supported_by_the_slave_converter() -> None:
    catalog, opaque_names = _load_catalog()

    assert len(catalog) == 1_216
    assert sum(len(entry["applicableUnits"]) for entry in catalog.values()) == 10_338
    assert set(opaque_names) == set(OPAQUE_QUANTITY_KINDS)
    for name, entry in catalog.items():
        units = entry["applicableUnits"]
        assert units
        assert len(units) == len(set(units))
        if name in opaque_names:
            continue
        reference = units[0]
        for unit in units:
            _assert_bidirectional_conversion(unit, reference, f"quantityKindData[{name!r}]")


def test_solver_manifests_only_reference_convertible_catalog_units() -> None:
    catalog, opaque_names = _load_catalog()

    for manifest in registry.manifests():
        descriptor = manifest["descriptor"]
        identity = f"{descriptor['name']}@{descriptor['version']}"
        for descriptor in _quantity_descriptors(manifest):
            name = descriptor["quantityKind"]
            target = descriptor["unit"]
            assert name in catalog, f"{identity}: unknown QuantityKind {name}"
            assert name not in opaque_names, f"{identity}: opaque QuantityKind {name} cannot be a solver contract"
            assert target in catalog[name]["applicableUnits"], f"{identity}: {name} does not include {target}"
            for source in catalog[name]["applicableUnits"]:
                _assert_bidirectional_conversion(source, target, f"{identity}:{name}")

        reference_length_unit = manifest["descriptor"]["referenceLengthUnit"]
        assert reference_length_unit in catalog["Length"]["applicableUnits"]
        for source in catalog["Length"]["applicableUnits"]:
            _assert_bidirectional_conversion(source, reference_length_unit, f"{identity}:referenceLengthUnit")
