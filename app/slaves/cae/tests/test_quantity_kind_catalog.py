from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.solver_framework.units import convert_ucum_value


REPO_ROOT = Path(__file__).resolve().parents[4]
UI_ROOT = REPO_ROOT / "app" / "ui"
OPAQUE_QUANTITY_KINDS = (
    "LinearLogarithmicRatio",
    "thermodynamics.AreaTimeTemperature",
    "thermodynamics.LengthTemperatureTime",
    "thermodynamics.TemperatureVariance",
    "chemistry.Acidity",
    "chemistry.Basicity",
)


def _load_catalog() -> tuple[dict[str, Any], tuple[str, ...]]:
    manifest = json.loads(
        (UI_ROOT / "src" / "lib" / "cad" / "api" / "authoring-manifest.json").read_text(encoding="utf-8")
    )
    asset = (
        UI_ROOT / "public" / "assets" / f"quantity-kind-data-{manifest['quantityKindDataVersion']}.js"
    ).read_text(encoding="utf-8")
    data_match = re.search(r"const data=(.*)\nfor\(", asset, re.DOTALL)
    opaque_match = re.search(r"export const opaqueQuantityKindNames=Object\.freeze\((.*)\)\n", asset)
    assert data_match is not None
    assert opaque_match is not None
    return json.loads(data_match.group(1)), tuple(json.loads(opaque_match.group(1)))


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


def test_generated_catalog_units_are_supported_by_the_slave_converter() -> None:
    catalog, opaque_names = _load_catalog()

    assert len(catalog) == 1_216
    assert sum(len(entry["applicableUnits"]) for entry in catalog.values()) == 10_338
    assert opaque_names == OPAQUE_QUANTITY_KINDS
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

    for manifest_path in (REPO_ROOT / "app" / "slaves" / "cae" / "app" / "solvers").glob("*/manifest.json"):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for descriptor in _quantity_descriptors(manifest):
            name = descriptor["quantityKind"]
            target = descriptor["unit"]
            assert name in catalog, f"{manifest_path}: unknown QuantityKind {name}"
            assert name not in opaque_names, f"{manifest_path}: opaque QuantityKind {name} cannot be a solver contract"
            assert target in catalog[name]["applicableUnits"], f"{manifest_path}: {name} does not include {target}"
            for source in catalog[name]["applicableUnits"]:
                _assert_bidirectional_conversion(source, target, f"{manifest_path}:{name}")

        reference_length_unit = manifest["descriptor"]["referenceLengthUnit"]
        assert reference_length_unit in catalog["Length"]["applicableUnits"]
        for source in catalog["Length"]["applicableUnits"]:
            _assert_bidirectional_conversion(source, reference_length_unit, f"{manifest_path}:referenceLengthUnit")
